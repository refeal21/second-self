//! Materialize a bounded SQLite read image from captured bytes, never paths.
//! Format/checksum rules: https://sqlite.org/fileformat2.html#walformat
//! Corrupt, partial and old-reset-generation tails are deliberately rejected;
//! only complete checksum-valid uncommitted frames may be ignored.

pub(super) fn materialize(
    main: &[u8],
    wal: Option<&[u8]>,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if main.len() > limit {
        return Err("snapshot_image_limit: main database".into());
    }
    let page_size = database_page_size(main)?;
    if main.len() % page_size != 0 {
        return Err("inconsistent_database: partial main page".into());
    }
    let main_pages = database_pages(main, page_size)?;
    let mut image = main[..main_pages * page_size].to_vec();
    if let Some(wal) = wal.filter(|bytes| !bytes.is_empty()) {
        if wal.len() > limit {
            return Err("snapshot_image_limit: WAL bytes".into());
        }
        if main[18..20] != [2, 2] {
            return Err("unaccounted_wal: main is not in WAL mode".into());
        }
        validate_and_apply(wal, page_size, limit, &mut image)?;
    }
    // The derived in-memory view alone changes these mode bytes. Verbatim
    // captured evidence is retained separately. SQLite documents this step for
    // deserialize: https://sqlite.org/c3ref/deserialize.html
    if database_page_size(&image)? != page_size {
        return Err("inconsistent_database: committed page size changed".into());
    }
    if database_pages(&image, page_size)? * page_size != image.len() {
        return Err("inconsistent_database: committed size disagrees with database header".into());
    }
    image[18] = 1;
    image[19] = 1;
    Ok(image)
}

fn validate_and_apply(
    wal: &[u8],
    page_size: usize,
    limit: usize,
    image: &mut Vec<u8>,
) -> Result<(), String> {
    if wal.len() < 32 {
        return Err("unaccounted_wal: incomplete header".into());
    }
    let big_endian = match word(wal, 0) {
        0x377f0682 => false,
        0x377f0683 => true,
        _ => return Err("unaccounted_wal: invalid magic".into()),
    };
    if word(wal, 4) != 3_007_000 || word(wal, 8) as usize != page_size {
        return Err("unaccounted_wal: version or page size mismatch".into());
    }
    let mut sum = checksum(&wal[..24], [0, 0], big_endian);
    if sum != [word(wal, 24), word(wal, 28)] {
        return Err("unaccounted_wal: header checksum mismatch".into());
    }
    let frame_size = page_size + 24;
    if (wal.len() - 32) % frame_size != 0 {
        return Err("unaccounted_wal: incomplete frame tail".into());
    }
    let frames = &wal[32..];
    // Validate every frame, including all frames after the latest commit.
    // A checksum failure is never interpreted as permission to use older data.
    for frame in frames.chunks_exact(frame_size) {
        if frame[8..16] != wal[16..24] {
            return Err("unaccounted_wal: salt mismatch or unsupported old-reset tail".into());
        }
        let page = word(frame, 0) as usize;
        if page == 0 {
            return Err("unaccounted_wal: zero page number".into());
        }
        bounded_size(page, page_size, limit)?;
        let committed_pages = word(frame, 4) as usize;
        if committed_pages > 0 {
            bounded_size(committed_pages, page_size, limit)?;
        }
        sum = checksum(&frame[..8], sum, big_endian);
        sum = checksum(&frame[24..], sum, big_endian);
        if sum != [word(frame, 16), word(frame, 20)] {
            return Err("unaccounted_wal: frame checksum mismatch".into());
        }
    }
    // Replay complete transactions only. Respect every commit's truncate/grow
    // boundary so a later growth cannot resurrect bytes removed by a shrink.
    let mut transaction_start = 0;
    for (index, frame) in frames.chunks_exact(frame_size).enumerate() {
        let committed_pages = word(frame, 4) as usize;
        if committed_pages == 0 {
            continue;
        }
        let length = bounded_size(committed_pages, page_size, limit)?;
        // Vec's geometric growth can exceed the byte bound even when the
        // requested length does not. Reserve only the validated target size.
        if length > image.capacity() {
            image
                .try_reserve_exact(length - image.len())
                .map_err(|_| "snapshot_image_limit: derived allocation unavailable")?;
        }
        image.resize(length, 0);
        let transaction_end = (index + 1) * frame_size;
        for page in frames[transaction_start..transaction_end].chunks_exact(frame_size) {
            let number = word(page, 0) as usize;
            // Pages deleted at this commit do not survive the transaction.
            if number <= committed_pages {
                let offset = (number - 1) * page_size;
                image[offset..offset + page_size].copy_from_slice(&page[24..]);
            }
        }
        transaction_start = transaction_end;
    }
    Ok(())
}

fn bounded_size(pages: usize, page_size: usize, limit: usize) -> Result<usize, String> {
    pages
        .checked_mul(page_size)
        .filter(|size| *size <= limit)
        .ok_or_else(|| "snapshot_image_limit: WAL page or committed growth exceeds bound".into())
}

fn database_page_size(bytes: &[u8]) -> Result<usize, String> {
    if bytes.len() < 100 || &bytes[..16] != b"SQLite format 3\0" {
        return Err("inconsistent_database: invalid main header".into());
    }
    let value = u16::from_be_bytes([bytes[16], bytes[17]]) as usize;
    let page = if value == 1 { 65536 } else { value };
    if !(512..=65536).contains(&page)
        || !page.is_power_of_two()
        || !matches!(bytes[18], 1 | 2)
        || bytes[18] != bytes[19]
    {
        return Err("inconsistent_database: invalid page size or mode".into());
    }
    Ok(page)
}

fn database_pages(bytes: &[u8], page_size: usize) -> Result<usize, String> {
    let stored = word(bytes, 28) as usize;
    let pages = if stored > 0 && bytes[24..28] == bytes[92..96] {
        stored
    } else {
        bytes.len() / page_size
    };
    if pages == 0 || pages > bytes.len() / page_size {
        return Err("inconsistent_database: invalid main database size".into());
    }
    Ok(pages)
}

fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("validated frame/header length"),
    )
}

fn checksum(bytes: &[u8], mut sum: [u32; 2], big_endian: bool) -> [u32; 2] {
    for pair in bytes.chunks_exact(8) {
        let read = |b: &[u8]| {
            if big_endian {
                u32::from_be_bytes(b.try_into().unwrap())
            } else {
                u32::from_le_bytes(b.try_into().unwrap())
            }
        };
        sum[0] = sum[0].wrapping_add(read(&pair[..4])).wrapping_add(sum[1]);
        sum[1] = sum[1].wrapping_add(read(&pair[4..])).wrapping_add(sum[0]);
    }
    sum
}
