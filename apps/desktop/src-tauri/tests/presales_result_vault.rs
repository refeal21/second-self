use digital_twin_desktop_lib::presales_queue::{ResultBinding, ResultVault};
use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const MAX_PNG_BYTES: usize = 52_428_800;

static ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

struct FixtureRoot(PathBuf);

impl FixtureRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "digital-twin-result-vault-{}-{}",
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
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn solid_png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(Cursor::new(&mut bytes), width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().unwrap();
    writer
        .write_image_data(&vec![0x5a; width as usize * height as usize * 3])
        .unwrap();
    writer.finish().unwrap();
    bytes
}

fn animated_png() -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(Cursor::new(&mut bytes), 2, 2);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_animated(1, 0).unwrap();
    let mut writer = encoder.write_header().unwrap();
    writer.write_image_data(&[0x5a; 12]).unwrap();
    writer.finish().unwrap();
    bytes
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

fn with_dimensions(mut png: Vec<u8>, width: u32, height: u32) -> Vec<u8> {
    png[16..20].copy_from_slice(&width.to_be_bytes());
    png[20..24].copy_from_slice(&height.to_be_bytes());
    let crc = crc32(&png[12..29]);
    png[29..33].copy_from_slice(&crc.to_be_bytes());
    png
}

fn corrupt_chunk_data(mut png: Vec<u8>, kind: &[u8; 4]) -> Vec<u8> {
    let mut offset = 8;
    while offset + 12 <= png.len() {
        let length = u32::from_be_bytes(png[offset..offset + 4].try_into().unwrap()) as usize;
        if &png[offset + 4..offset + 8] == kind && length > 0 {
            png[offset + 8] ^= 1;
            return png;
        }
        offset += 12 + length;
    }
    panic!("fixture did not contain requested PNG chunk");
}

fn result_dir(root: &FixtureRoot) -> PathBuf {
    root.path().join("queue-results/r1")
}

fn stage_once(root: &FixtureRoot) -> (ResultBinding, Vec<u8>) {
    let binding = binding();
    let png = solid_png(16, 9);
    ResultVault::open(root.path())
        .unwrap()
        .stage(&binding, &png)
        .unwrap();
    (binding, png)
}

fn binding() -> ResultBinding {
    ResultBinding {
        request_id: "r1".into(),
        attempt_id: "a1".into(),
        target_sha256: "a".repeat(64),
    }
}

#[test]
fn stages_and_recovers_a_verified_png() {
    let root = FixtureRoot::new();
    let vault = ResultVault::open(root.path()).unwrap();
    let binding = binding();
    let png = solid_png(16, 9);

    let staged = vault.stage(&binding, &png).unwrap();

    assert_eq!(staged.manifest().relative_path, "queue-results/r1/a1.png");
    assert_eq!(staged.dimensions(), (16, 9));
    assert_eq!(
        fs::read(root.path().join("queue-results/r1/a1.png")).unwrap(),
        png
    );
    assert_eq!(
        ResultVault::open(root.path())
            .unwrap()
            .recover(&binding)
            .unwrap()
            .manifest(),
        staged.manifest()
    );
}

#[test]
fn rejects_invalid_binding_before_creating_result_directories() {
    for bad_binding in [
        ResultBinding {
            request_id: "../escape".into(),
            ..binding()
        },
        ResultBinding {
            attempt_id: "UPPER".into(),
            ..binding()
        },
        ResultBinding {
            target_sha256: "A".repeat(64),
            ..binding()
        },
        ResultBinding {
            target_sha256: "a".repeat(63),
            ..binding()
        },
    ] {
        let root = FixtureRoot::new();
        let vault = ResultVault::open(root.path()).unwrap();
        assert!(vault.stage(&bad_binding, &solid_png(1, 1)).is_err());
        assert!(fs::read_dir(root.path()).unwrap().next().is_none());
    }
}

#[test]
fn rejects_invalid_png_content_and_all_staging_bounds() {
    let cases = [
        Vec::new(),
        b"not a png".to_vec(),
        solid_png(2, 2)[..20].to_vec(),
        corrupt_chunk_data(solid_png(2, 2), b"IDAT"),
        {
            let mut corrupted = solid_png(2, 2);
            let index = corrupted.len() - 5;
            corrupted[index] ^= 1;
            corrupted
        },
        animated_png(),
        with_dimensions(solid_png(1, 1), 8193, 1),
        with_dimensions(solid_png(1, 1), 4097, 4096),
        vec![0; MAX_PNG_BYTES + 1],
    ];

    for png in cases {
        let root = FixtureRoot::new();
        let vault = ResultVault::open(root.path()).unwrap();
        assert!(vault.stage(&binding(), &png).is_err());
        assert!(fs::read_dir(root.path()).unwrap().next().is_none());
    }
}

#[test]
fn exact_replay_reuses_unchanged_immutable_files() {
    let root = FixtureRoot::new();
    let (binding, png) = stage_once(&root);
    let manifest_before = fs::read(result_dir(&root).join("a1.json")).unwrap();

    let repeated = ResultVault::open(root.path())
        .unwrap()
        .stage(&binding, &png)
        .unwrap();

    assert_eq!(repeated.dimensions(), (16, 9));
    assert_eq!(fs::read(result_dir(&root).join("a1.png")).unwrap(), png);
    assert_eq!(
        fs::read(result_dir(&root).join("a1.json")).unwrap(),
        manifest_before
    );
}

#[test]
fn conflicting_bytes_or_target_never_replace_the_original() {
    let root = FixtureRoot::new();
    let (binding, png) = stage_once(&root);
    let manifest = fs::read(result_dir(&root).join("a1.json")).unwrap();

    assert!(ResultVault::open(root.path())
        .unwrap()
        .stage(&binding, &solid_png(17, 9))
        .is_err());
    let changed_target = ResultBinding {
        target_sha256: "b".repeat(64),
        ..binding
    };
    assert!(ResultVault::open(root.path())
        .unwrap()
        .stage(&changed_target, &png)
        .is_err());

    assert_eq!(fs::read(result_dir(&root).join("a1.png")).unwrap(), png);
    assert_eq!(
        fs::read(result_dir(&root).join("a1.json")).unwrap(),
        manifest
    );
}

#[cfg(unix)]
#[test]
fn rejects_parent_and_final_symlinks_without_writing_outside_root() {
    use std::os::unix::fs::symlink;

    let root = FixtureRoot::new();
    let outside = FixtureRoot::new();
    symlink(outside.path(), root.path().join("queue-results")).unwrap();
    assert!(ResultVault::open(root.path())
        .unwrap()
        .stage(&binding(), &solid_png(2, 2))
        .is_err());
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());

    fs::remove_file(root.path().join("queue-results")).unwrap();
    fs::create_dir(root.path().join("queue-results")).unwrap();
    symlink(outside.path(), root.path().join("queue-results/r1")).unwrap();
    assert!(ResultVault::open(root.path())
        .unwrap()
        .stage(&binding(), &solid_png(2, 2))
        .is_err());
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());

    fs::remove_file(root.path().join("queue-results/r1")).unwrap();
    fs::create_dir(root.path().join("queue-results/r1")).unwrap();
    symlink(
        outside.path().join("outside.png"),
        result_dir(&root).join("a1.png"),
    )
    .unwrap();
    assert!(ResultVault::open(root.path())
        .unwrap()
        .stage(&binding(), &solid_png(2, 2))
        .is_err());
    assert!(!outside.path().join("outside.png").exists());

    fs::remove_file(result_dir(&root).join("a1.png")).unwrap();
    let png = solid_png(2, 2);
    fs::write(result_dir(&root).join("a1.png"), &png).unwrap();
    symlink(
        outside.path().join("outside.json"),
        result_dir(&root).join("a1.json"),
    )
    .unwrap();
    assert!(ResultVault::open(root.path())
        .unwrap()
        .stage(&binding(), &png)
        .is_err());
    assert!(!outside.path().join("outside.json").exists());
}

#[cfg(unix)]
#[test]
fn rejects_directories_and_fifos_at_final_paths_without_blocking() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    for name in ["a1.png", "a1.json"] {
        for fifo in [false, true] {
            let root = FixtureRoot::new();
            fs::create_dir_all(result_dir(&root)).unwrap();
            let final_path = result_dir(&root).join(name);
            if fifo {
                let path = CString::new(final_path.as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            } else {
                fs::create_dir(&final_path).unwrap();
            }
            assert!(ResultVault::open(root.path())
                .unwrap()
                .stage(&binding(), &solid_png(2, 2))
                .is_err());
        }
    }
}

#[test]
fn recovery_rejects_missing_or_tampered_png_and_png_only_interruptions() {
    let root = FixtureRoot::new();
    fs::create_dir_all(result_dir(&root)).unwrap();
    fs::write(result_dir(&root).join("a1.png"), solid_png(2, 2)).unwrap();
    assert!(ResultVault::open(root.path())
        .unwrap()
        .recover(&binding())
        .is_err());

    fs::remove_file(result_dir(&root).join("a1.png")).unwrap();
    let (binding, _) = stage_once(&root);
    fs::remove_file(result_dir(&root).join("a1.png")).unwrap();
    assert!(ResultVault::open(root.path())
        .unwrap()
        .recover(&binding)
        .is_err());

    fs::write(result_dir(&root).join("a1.png"), solid_png(15, 9)).unwrap();
    assert!(ResultVault::open(root.path())
        .unwrap()
        .recover(&binding)
        .is_err());
}

#[test]
fn recovery_rejects_oversized_unknown_or_changed_manifest_metadata() {
    for mutation in 0..3 {
        let root = FixtureRoot::new();
        let (binding, _) = stage_once(&root);
        let path = result_dir(&root).join("a1.json");
        match mutation {
            0 => fs::write(&path, vec![b' '; 70_000]).unwrap(),
            1 => {
                let bytes = fs::read(&path).unwrap();
                let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                value["unknown"] = serde_json::json!(true);
                fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            }
            2 => {
                let bytes = fs::read(&path).unwrap();
                let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                value["width"] = serde_json::json!(99);
                fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(ResultVault::open(root.path())
            .unwrap()
            .recover(&binding)
            .is_err());
    }
}

#[test]
fn concurrent_vault_handles_stage_independent_attempts() {
    let root = FixtureRoot::new();
    let first = ResultVault::open(root.path()).unwrap();
    let second = ResultVault::open(root.path()).unwrap();
    let first_binding = binding();
    let second_binding = ResultBinding {
        request_id: "r2".into(),
        attempt_id: "a2".into(),
        ..binding()
    };
    let first_png = solid_png(16, 9);
    let second_png = solid_png(4, 3);

    let (first_result, second_result) = std::thread::scope(|scope| {
        let first_task = scope.spawn(|| first.stage(&first_binding, &first_png).unwrap());
        let second_task = scope.spawn(|| second.stage(&second_binding, &second_png).unwrap());
        (first_task.join().unwrap(), second_task.join().unwrap())
    });

    assert_eq!(first_result.dimensions(), (16, 9));
    assert_eq!(second_result.dimensions(), (4, 3));
    assert_eq!(
        fs::read(root.path().join("queue-results/r2/a2.png")).unwrap(),
        second_png
    );
}

#[cfg(unix)]
#[test]
fn root_rename_and_replacement_cannot_redirect_a_held_vault() {
    let root = FixtureRoot::new();
    let vault = ResultVault::open(root.path()).unwrap();
    let held_path = root.path().with_extension("held");
    fs::rename(root.path(), &held_path).unwrap();
    fs::create_dir(root.path()).unwrap();

    vault.stage(&binding(), &solid_png(2, 2)).unwrap();

    assert!(held_path.join("queue-results/r1/a1.png").is_file());
    assert!(fs::read_dir(root.path()).unwrap().next().is_none());
    fs::remove_dir_all(&held_path).unwrap();
}

#[test]
fn recovery_rejects_manifest_binding_path_size_and_hash_changes() {
    for field in [
        "binding",
        "relativePath",
        "byteLength",
        "sha256",
        "schemaVersion",
    ] {
        let root = FixtureRoot::new();
        let (binding, _) = stage_once(&root);
        let path = result_dir(&root).join("a1.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match field {
            "binding" => value["binding"]["attemptId"] = serde_json::json!("other"),
            "relativePath" => value["result"]["relativePath"] = serde_json::json!("other.png"),
            "byteLength" => value["result"]["byteLength"] = serde_json::json!(1),
            "sha256" => value["result"]["sha256"] = serde_json::json!("b".repeat(64)),
            "schemaVersion" => value["schemaVersion"] = serde_json::json!(2),
            _ => unreachable!(),
        }
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(&serde_json::to_vec(&value).unwrap())
            .unwrap();
        file.sync_all().unwrap();
        assert!(ResultVault::open(root.path())
            .unwrap()
            .recover(&binding)
            .is_err());
    }
}
