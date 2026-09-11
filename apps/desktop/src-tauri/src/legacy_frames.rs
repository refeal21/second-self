//! Byte ceilings include JSON and base64, not just the decoded asset. Codex's
//! 96 MiB admits a 50 MiB PNG plus metadata. Worker QA can include a 128 MiB PDF,
//! 64 MiB PPTX and multiple 32 MiB pages/visuals; its separate aggregate ceiling
//! is 1 GiB. Legacy has no aggregate QA limit; larger frames fail explicitly.
pub(crate) const CODEX_FRAME_LIMIT: usize = 96 * 1024 * 1024;
pub(crate) const WORKER_FRAME_LIMIT: usize = 1024 * 1024 * 1024;

pub(crate) struct FrameDecoder {
    bytes: Vec<u8>,
    discarding: bool,
    limit: usize,
}
impl FrameDecoder {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            discarding: false,
            limit,
        }
    }
    pub(crate) fn push(&mut self, bytes: &[u8], mut frame: impl FnMut(Result<&[u8], ()>)) {
        for part in bytes.split_inclusive(|b| *b == b'\n') {
            if !self.discarding {
                if self.bytes.len().saturating_add(part.len()) > self.limit {
                    self.bytes.clear();
                    self.discarding = true;
                    frame(Err(()));
                } else {
                    let needed = self.bytes.len() + part.len();
                    if needed > self.bytes.capacity() {
                        let capacity = needed
                            .max(self.bytes.capacity().saturating_mul(2))
                            .min(self.limit);
                        if self
                            .bytes
                            .try_reserve_exact(capacity - self.bytes.len())
                            .is_err()
                        {
                            self.bytes.clear();
                            self.discarding = true;
                            frame(Err(()));
                        }
                    }
                    if !self.discarding {
                        self.bytes.extend_from_slice(part);
                    }
                }
            }
            if part.last() == Some(&b'\n') {
                if !self.discarding {
                    frame(Ok(&self.bytes));
                    self.bytes.clear();
                }
                if self.bytes.capacity() > 1024 * 1024 {
                    self.bytes = Vec::new();
                }
                self.discarding = false;
            }
        }
    }
    pub(crate) fn finish(&mut self) -> Result<(), ()> {
        let incomplete = !self.bytes.is_empty() || self.discarding;
        self.bytes.clear();
        self.discarding = false;
        if incomplete {
            Err(())
        } else {
            Ok(())
        }
    }
}
