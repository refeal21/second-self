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
        let png = self.root.read(
            &["queue-results", &binding.request_id, &png_name(binding)],
            MAX_PNG_BYTES,
        )?;
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
    let decoder = png::Decoder::new_with_limits(
        Cursor::new(bytes),
        png::Limits {
            bytes: DECODER_ALLOCATION_LIMIT,
        },
    );
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
