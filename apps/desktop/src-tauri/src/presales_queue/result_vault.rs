use super::{
    result_files::RootDirectory, store::validate_hash, store::validate_identifier, StagedResult,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Cursor, path::Path};

const MAX_PNG_BYTES: usize = 52_428_800;
const MAX_DIMENSION: u32 = 8192;
const MAX_PIXELS: u64 = 16_777_216;
const MAX_DECODED_FRAME_BYTES: usize = 134_217_728;
const DECODER_ALLOCATION_LIMIT: usize = 67_108_864;
const MAX_MANIFEST_BYTES: usize = 65_536;

pub struct ResultVault {
    root: RootDirectory,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultBinding {
    pub request_id: String,
    pub attempt_id: String,
    pub target_sha256: String,
}

pub struct VerifiedPngResult {
    manifest: StagedResult,
    binding: ResultBinding,
    dimensions: (u32, u32),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultManifest {
    schema_version: u32,
    binding: ResultBinding,
    result: StagedResult,
    width: u32,
    height: u32,
}

impl VerifiedPngResult {
    pub fn manifest(&self) -> &StagedResult {
        &self.manifest
    }

    pub fn binding(&self) -> &ResultBinding {
        &self.binding
    }

    pub fn dimensions(&self) -> (u32, u32) {
        self.dimensions
    }
}

impl ResultVault {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, String> {
        Ok(Self {
            root: RootDirectory::open(root.as_ref())?,
        })
    }

    pub fn stage(&self, binding: &ResultBinding, png: &[u8]) -> Result<VerifiedPngResult, String> {
        validate_binding(binding)?;
        let dimensions = validate_png(png)?;
        let manifest = StagedResult {
            relative_path: png_relative_path(binding),
            sha256: hex_sha256(png),
            byte_length: u64::try_from(png.len())
                .map_err(|_| "PNG byte length cannot be represented".to_string())?,
        };
        let sidecar = ResultManifest {
            schema_version: 1,
            binding: binding.clone(),
            result: manifest.clone(),
            width: dimensions.0,
            height: dimensions.1,
        };
        let sidecar_bytes = serde_json::to_vec(&sidecar)
            .map_err(|error| format!("Result manifest cannot be serialized: {error}"))?;
        self.root.write_immutable(
            &["queue-results", &binding.request_id, &png_name(binding)],
            png,
        )?;
        self.root.write_immutable(
            &[
                "queue-results",
                &binding.request_id,
                &manifest_name(binding),
            ],
            &sidecar_bytes,
        )?;
        Ok(VerifiedPngResult {
            manifest,
            binding: binding.clone(),
            dimensions,
        })
    }

    pub fn recover(&self, binding: &ResultBinding) -> Result<VerifiedPngResult, String> {
        validate_binding(binding)?;
        // Establish PNG durability before the manifest that makes it recovery proof.
        let png = self.root.read(
            &["queue-results", &binding.request_id, &png_name(binding)],
            MAX_PNG_BYTES,
        )?;
        let sidecar_bytes = self.root.read(
            &[
                "queue-results",
                &binding.request_id,
                &manifest_name(binding),
            ],
            MAX_MANIFEST_BYTES,
        )?;
        let sidecar: ResultManifest = serde_json::from_slice(&sidecar_bytes)
            .map_err(|error| format!("Result manifest is invalid: {error}"))?;
        if sidecar.schema_version != 1 {
            return Err("Result manifest has an unsupported schema version".into());
        }
        if sidecar.binding != *binding {
            return Err("Result manifest binding does not match the requested attempt".into());
        }
        if sidecar.result.relative_path != png_relative_path(binding) {
            return Err("Result manifest path does not match the requested attempt".into());
        }
        validate_hash(&sidecar.result.sha256, "result.sha256")?;
        if sidecar.result.byte_length == 0 || sidecar.result.byte_length > MAX_PNG_BYTES as u64 {
            return Err("Result manifest byte length is outside the PNG bounds".into());
        }
        if sidecar.result.byte_length != png.len() as u64 {
            return Err("Result PNG size does not match its manifest".into());
        }
        if sidecar.result.sha256 != hex_sha256(&png) {
            return Err("Result PNG hash does not match its manifest".into());
        }
        let dimensions = validate_png(&png)?;
        if dimensions != (sidecar.width, sidecar.height) {
            return Err("Result PNG dimensions do not match its manifest".into());
        }
        Ok(VerifiedPngResult {
            manifest: sidecar.result,
            binding: sidecar.binding,
            dimensions,
        })
    }
}

fn validate_binding(binding: &ResultBinding) -> Result<(), String> {
    validate_identifier(&binding.request_id, "request_id")?;
    validate_identifier(&binding.attempt_id, "attempt_id")?;
    validate_hash(&binding.target_sha256, "target_sha256")
}

fn png_name(binding: &ResultBinding) -> String {
    format!("{}.png", binding.attempt_id)
}

fn manifest_name(binding: &ResultBinding) -> String {
    format!("{}.json", binding.attempt_id)
}

fn png_relative_path(binding: &ResultBinding) -> String {
    format!(
        "queue-results/{}/{}.png",
        binding.request_id, binding.attempt_id
    )
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_png(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.is_empty() || bytes.len() > MAX_PNG_BYTES {
        return Err(format!("PNG must contain 1..={MAX_PNG_BYTES} bytes"));
    }
    let mut options = png::DecodeOptions::default();
    options.set_ignore_adler32(false);
    options.set_skip_ancillary_crc_failures(false);
    let mut decoder = png::Decoder::new_with_options(Cursor::new(bytes), options);
    decoder.set_limits(png::Limits {
        bytes: DECODER_ALLOCATION_LIMIT,
    });
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("PNG header is invalid: {error}"))?;
    if reader.info().animation_control.is_some() {
        return Err("Animated PNG is not supported".into());
    }
    let (width, height) = reader.info().size();
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(format!(
            "PNG dimensions must each be 1..={MAX_DIMENSION} pixels"
        ));
    }
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| "PNG pixel count overflowed".to_string())?;
    if pixels > MAX_PIXELS {
        return Err(format!("PNG exceeds the {MAX_PIXELS} pixel limit"));
    }
    let output_size = reader
        .output_buffer_size()
        .ok_or_else(|| "PNG decoded frame size overflowed".to_string())?;
    if output_size > MAX_DECODED_FRAME_BYTES {
        return Err(format!(
            "PNG decoded frame exceeds {MAX_DECODED_FRAME_BYTES} bytes"
        ));
    }
    let mut decoded = vec![0; output_size];
    let output = reader
        .next_frame(&mut decoded)
        .map_err(|error| format!("PNG image data is invalid: {error}"))?;
    if (output.width, output.height) != (width, height) {
        return Err("PNG frame dimensions do not match its header".into());
    }
    reader
        .finish()
        .map_err(|error| format!("PNG trailing chunks are invalid: {error}"))?;
    Ok((width, height))
}

#[cfg(all(test, unix))]
mod durability_tests {
    use super::*;
    use crate::presales_queue::result_files::{clear_sync_failures, inject_sync_failures};
    use std::{
        fs,
        io::Cursor,
        os::unix::fs::MetadataExt,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    static ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    struct FixtureRoot(PathBuf);

    impl FixtureRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "digital-twin-result-durability-{}-{}",
                std::process::id(),
                ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for FixtureRoot {
        fn drop(&mut self) {
            clear_sync_failures();
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn binding() -> ResultBinding {
        ResultBinding {
            request_id: "r1".into(),
            attempt_id: "a1".into(),
            target_sha256: "a".repeat(64),
        }
    }

    fn solid_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(Cursor::new(&mut bytes), 2, 2);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[0x5a; 12]).unwrap();
        writer.finish().unwrap();
        bytes
    }

    fn identity(path: &Path) -> (u64, u64) {
        let metadata = fs::metadata(path).unwrap();
        (metadata.dev(), metadata.ino())
    }

    fn staged_fixture() -> (FixtureRoot, ResultVault, ResultBinding, Vec<u8>) {
        let root = FixtureRoot::new();
        let vault = ResultVault::open(root.path()).unwrap();
        let binding = binding();
        let png = solid_png();
        vault.stage(&binding, &png).unwrap();
        (root, vault, binding, png)
    }

    #[test]
    fn recovery_requires_png_durability_before_manifest_durability() {
        let (root, vault, binding, _) = staged_fixture();
        let result_dir = root.path().join("queue-results/r1");
        inject_sync_failures(vec![
            (identity(&result_dir.join("a1.png")), "png"),
            (identity(&result_dir.join("a1.json")), "manifest"),
        ]);

        let error = match vault.recover(&binding) {
            Ok(_) => panic!("recovery unexpectedly ignored injected sync failures"),
            Err(error) => error,
        };
        clear_sync_failures();

        assert!(
            error.contains("png"),
            "unexpected first sync failure: {error}"
        );
    }

    #[test]
    fn recovery_requires_existing_ancestor_directory_durability() {
        let (root, vault, binding, _) = staged_fixture();
        inject_sync_failures(vec![(identity(root.path()), "root directory")]);

        let result = vault.recover(&binding);
        clear_sync_failures();

        assert!(result.is_err());
    }

    #[test]
    fn exact_replay_requires_existing_ancestor_directory_durability() {
        let (root, _, binding, png) = staged_fixture();
        let replay = ResultVault::open(root.path()).unwrap();
        inject_sync_failures(vec![(identity(root.path()), "root directory")]);

        let result = replay.stage(&binding, &png);
        clear_sync_failures();

        assert!(result.is_err());
    }
}
