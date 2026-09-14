use super::{EnqueueBatch, ProviderIdentity, QueueStore, StagedResult};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    jsonrpc: String,
    id: String,
    method: String,
    params: Value,
}

macro_rules! params {
    ($name:ident { $($field:ident: $type:ty),* $(,)? }) => {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct $name { $($field: $type),* }
    };
}
params!(Empty {});
params!(Enqueue {
    input: EnqueueBatch
});
params!(Concurrency { value: u8 });
params!(Pause { paused: bool });
params!(BatchPause {
    batch_id: String,
    paused: bool
});
params!(Epoch { epoch: i64 });
params!(RequestId { request_id: String });
params!(Attempt {
    epoch: i64,
    request_id: String,
    attempt_id: String
});
params!(Provider {
    epoch: i64,
    request_id: String,
    attempt_id: String,
    identity: ProviderIdentity
});
params!(Failed {
    epoch: i64,
    request_id: String,
    attempt_id: String,
    error: String
});
params!(Unknown {
    epoch: i64,
    request_id: String,
    attempt_id: String,
    reason: String
});
params!(ResultReady {
    epoch: i64,
    request_id: String,
    attempt_id: String,
    result: StagedResult
});
params!(Abandon {
    request_id: String,
    acknowledge_duplicate_risk: bool
});
params!(LateResult {
    request_id: String,
    attempt_id: String,
    result: StagedResult
});

struct RpcError(i32, &'static str);
fn decode<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(|_| RpcError(-32602, "Invalid params"))
}
fn stored<T: Serialize>(result: Result<T, String>) -> Result<Value, RpcError> {
    // Store/serde errors may contain submitted values or local paths. The wire
    // boundary deliberately emits fixed messages instead of formatting them.
    let value = result.map_err(|_| RpcError(-32000, "Queue operation rejected"))?;
    serde_json::to_value(value).map_err(|_| RpcError(-32603, "Internal error"))
}
fn error(id: Value, error: RpcError) -> String {
    json!({"jsonrpc":"2.0", "id":id, "error":{"code":error.0,"message":error.1}}).to_string()
}

/// Short synchronous native queue operations only. Opening a connection does
/// not establish runtime ownership; the future supervisor must begin explicitly.
/// This dispatcher neither stages files nor publishes candidates or approvals.
pub fn handle_queue_rpc_line(store: &mut QueueStore, line: &str) -> String {
    if line.len() > 262_144 {
        return error(Value::Null, RpcError(-32600, "Invalid Request"));
    }
    if serde_json::from_str::<Value>(line).is_err() {
        return error(Value::Null, RpcError(-32700, "Parse error"));
    }
    // Deserialize the original envelope so repeated envelope fields also fail.
    let request = match serde_json::from_str::<Request>(line) {
        Ok(request)
            if request.jsonrpc == "2.0"
                && request.id.len() <= 128
                && request
                    .id
                    .strip_prefix("native:")
                    .is_some_and(|suffix| !suffix.trim().is_empty())
                && request.params.is_object() =>
        {
            request
        }
        _ => return error(Value::Null, RpcError(-32600, "Invalid Request")),
    };
    let id = Value::String(request.id);
    match dispatch(store, &request.method, request.params) {
        Ok(result) => json!({"jsonrpc":"2.0", "id":id, "result":result}).to_string(),
        Err(failure) => error(id, failure),
    }
}

fn dispatch(store: &mut QueueStore, method: &str, params: Value) -> Result<Value, RpcError> {
    match method {
        "native.queue.enqueue" => {
            let p: Enqueue = decode(params)?;
            stored(store.enqueue(p.input))
        }
        "native.queue.settings" => {
            let _: Empty = decode(params)?;
            stored(store.settings())
        }
        "native.queue.setConcurrency" => {
            let p: Concurrency = decode(params)?;
            stored(store.set_concurrency(p.value))
        }
        "native.queue.setPaused" => {
            let p: Pause = decode(params)?;
            stored(store.set_paused(p.paused))
        }
        "native.queue.setBatchPaused" => {
            let p: BatchPause = decode(params)?;
            stored(store.set_batch_paused(&p.batch_id, p.paused))
        }
        "native.queue.beginRuntime" => {
            let _: Empty = decode(params)?;
            stored(store.begin_runtime())
        }
        "native.queue.snapshot" => {
            let _: Empty = decode(params)?;
            stored(store.recovery_snapshot())
        }
        "native.queue.claim" => {
            let p: Epoch = decode(params)?;
            stored(store.claim_next(p.epoch))
        }
        "native.queue.provider" => {
            let p: Provider = decode(params)?;
            stored(store.record_provider(p.epoch, &p.request_id, &p.attempt_id, p.identity))
        }
        "native.queue.cancel" => {
            let p: RequestId = decode(params)?;
            stored(store.request_cancel(&p.request_id))
        }
        "native.queue.cancelled" => {
            let p: Attempt = decode(params)?;
            stored(store.confirm_cancelled(p.epoch, &p.request_id, &p.attempt_id))
        }
        "native.queue.failed" => {
            let p: Failed = decode(params)?;
            stored(store.mark_failed(p.epoch, &p.request_id, &p.attempt_id, &p.error))
        }
        "native.queue.unknown" => {
            let p: Unknown = decode(params)?;
            stored(store.mark_outcome_unknown(p.epoch, &p.request_id, &p.attempt_id, &p.reason))
        }
        "native.queue.result" => {
            let p: ResultReady = decode(params)?;
            stored(store.record_result_ready(p.epoch, &p.request_id, &p.attempt_id, p.result))
        }
        "native.queue.abandon" => {
            let p: Abandon = decode(params)?;
            stored(store.abandon_unresolved(&p.request_id, p.acknowledge_duplicate_risk))
        }
        "native.queue.lateResult" => {
            let p: LateResult = decode(params)?;
            stored(store.record_late_result(&p.request_id, &p.attempt_id, p.result))
        }
        "native.queue.events" => {
            let p: RequestId = decode(params)?;
            stored(store.events(&p.request_id))
        }
        _ => Err(RpcError(-32601, "Method not found")),
    }
}
