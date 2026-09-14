use crate::legacy_frames::{FrameDecoder, CODEX_FRAME_LIMIT};

#[test]
fn codex_framing_accepts_fifty_mib_encoded_png_without_truncation() {
    let encoded = (50 * 1024 * 1024_usize).div_ceil(3) * 4;
    let mut decoder = FrameDecoder::new(CODEX_FRAME_LIMIT);
    let mut observed = 0;
    decoder.push(b"{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"imageGeneration\",\"result\":\"",|_|panic!("not a frame yet"));
    let chunk = [b'A'; 8192];
    let mut left = encoded;
    while left > 0 {
        let n = left.min(chunk.len());
        decoder.push(&chunk[..n], |_| panic!("not a frame yet"));
        left -= n;
    }
    decoder.push(b"\"}}}\n", |frame| {
        let frame = frame.unwrap();
        assert!(frame.len() > encoded);
        assert!(frame.ends_with(b"\"}}}\n"));
        observed += 1;
    });
    assert_eq!(observed, 1);
}

#[test]
fn oversize_discards_until_delimiter_and_incomplete_utf8_remains_loss() {
    let mut decoder = FrameDecoder::new(8);
    let mut frames = Vec::new();
    decoder.push(b"123456789", |frame| frames.push(frame.map(|v| v.to_vec())));
    decoder.push(b"discard\n{}\n", |frame| {
        frames.push(frame.map(|v| v.to_vec()))
    });
    assert_eq!(frames, vec![Err(()), Ok(b"{}\n".to_vec())]);
    decoder.push(&[0xe4, 0xb8], |_| panic!("incomplete"));
    assert!(decoder.finish().is_err());
}

#[test]
fn actual_codex_limit_rejects_the_next_byte_before_allocating_an_unbounded_frame() {
    let mut decoder = FrameDecoder::new(CODEX_FRAME_LIMIT);
    let chunk = [b'x'; 8192];
    let mut lost = 0;
    for _ in 0..CODEX_FRAME_LIMIT / chunk.len() {
        decoder.push(&chunk, |_| panic!("still bounded"));
    }
    decoder.push(b"x", |frame| {
        assert!(frame.is_err());
        lost += 1;
    });
    decoder.push(b"\n{}\n", |frame| {
        assert_eq!(frame.unwrap(), b"{}\n");
    });
    assert_eq!(lost, 1);
}
