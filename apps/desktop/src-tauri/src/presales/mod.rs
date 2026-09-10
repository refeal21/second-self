mod validation;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use validation::{
    bundled_skill_metadata, native_value_hash, validate_pair, NATIVE_VALUE_HASH_ALGORITHM,
};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresalesDraftPair {
    pub schema_version: u32,
    pub outline: Value,
    pub details: Option<Value>,
}
