//! Native commit-boundary validation for newly authored v2 revision documents.
//! Historical v1 origins remain opaque and immutable; they are not reinterpreted here.
use serde_json::Value;
use std::collections::HashSet;

type Check = Result<(), String>;

fn keys(value: &Value, required: &[&str], optional: &[&str]) -> Check {
    let object = value.as_object().ok_or("Expected revision object")?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err("Unexpected or missing revision fields".into());
    }
    Ok(())
}

fn string(value: &Value) -> Result<&str, String> {
    value
        .as_str()
        .ok_or_else(|| "Expected revision string".into())
}

fn nonempty(value: &Value) -> Check {
    if string(value)?.is_empty() {
        return Err("Empty revision string".into());
    }
    Ok(())
}

fn completed(value: &Value) -> Check {
    if string(value)?.trim().is_empty() {
        return Err("Revision field is incomplete".into());
    }
    Ok(())
}

fn array(value: &Value) -> Result<&Vec<Value>, String> {
    value
        .as_array()
        .ok_or_else(|| "Expected revision array".into())
}

fn strings(value: &Value) -> Result<&Vec<Value>, String> {
    let values = array(value)?;
    for entry in values {
        string(entry)?;
    }
    Ok(values)
}

fn identifier(value: &Value) -> Check {
    let id = string(value)?;
    if !(2..=128).contains(&id.len())
        || !id.as_bytes()[0].is_ascii_lowercase()
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err("Invalid revision identifier".into());
    }
    Ok(())
}

fn unique_id(value: &Value, ids: &mut HashSet<String>) -> Check {
    identifier(value)?;
    if !ids.insert(string(value)?.into()) {
        return Err("Duplicate revision identifier".into());
    }
    Ok(())
}

fn references(value: &Value, known: &HashSet<&str>) -> Check {
    for entry in strings(value)? {
        if !known.contains(string(entry)?) {
            return Err("Unknown revision reference".into());
        }
    }
    Ok(())
}

/// New native events use RFC3339 timestamps. An unparseable legacy origin time is
/// not rewritten or rejected, matching the Worker's legacy chronology boundary.
pub(crate) fn time(at: &Value, baseline: &Value) -> Check {
    let parsed = chrono::DateTime::parse_from_rfc3339(string(at)?)
        .map_err(|_| "Invalid revision timestamp")?;
    if parsed.timestamp_subsec_nanos() >= 1_000_000_000 {
        return Err("Invalid revision timestamp".into());
    }
    if let Some(previous) = baseline
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    {
        if parsed < previous {
            return Err("Revision timestamp precedes checkpoint".into());
        }
    }
    Ok(())
}

pub(crate) fn event(event: &Value, baseline: &Value) -> Check {
    let kind = string(&event["kind"])?;
    let fields = match kind {
        "outline.revision.save" => vec![
            "kind",
            "at",
            "expectedRevision",
            "revisionId",
            "baseOutlineVersionId",
            "outline",
            "specs",
        ],
        "outline.revision.approve" | "outline.revision.cancel" => vec![
            "kind",
            "at",
            "expectedRevision",
            "revisionId",
            "baseOutlineVersionId",
        ],
        "details.submit" => vec!["kind", "at", "expectedRevision", "specs"],
        _ => return Err("Unknown revision event".into()),
    };
    keys(event, &fields, &[])?;
    if !event["expectedRevision"]
        .as_u64()
        .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
    {
        return Err("Invalid revision baseline".into());
    }
    if kind != "details.submit" {
        identifier(&event["revisionId"])?;
        identifier(&event["baseOutlineVersionId"])?;
    }
    time(&event["at"], baseline)
}

pub(crate) fn document(
    outline: &Value,
    specs: &Value,
    current: &Value,
    preserve_titles: bool,
) -> Check {
    keys(outline, &["title", "slides"], &[])?;
    completed(&outline["title"])?;
    let pages = array(&outline["slides"])?;
    let specs = array(specs)?;
    if pages.is_empty() || pages.len() != specs.len() {
        return Err("Revision pages and details must be nonempty and aligned".into());
    }
    let analysis = &current["analysis"]["output"];
    let known = |field: &str, id: &str| -> Result<HashSet<&str>, String> {
        array(&analysis[field])?
            .iter()
            .map(|entry| string(&entry[id]))
            .collect()
    };
    let sources = known("sourceMap", "sourceId")?;
    let findings = known("findings", "id")?;
    let data = known("dataPoints", "id")?;
    let mut page_ids = HashSet::new();
    for (page, spec) in pages.iter().zip(specs) {
        keys(
            page,
            &["id", "title", "purpose"],
            &["sourceIds", "findingIds", "dataPointIds"],
        )?;
        unique_id(&page["id"], &mut page_ids)?;
        completed(&page["title"])?;
        completed(&page["purpose"])?;
        keys(
            spec,
            &[
                "id",
                "title",
                "body",
                "tables",
                "charts",
                "shapes",
                "sourceMap",
                "imageGenerationBrief",
            ],
            &["findingIds", "dataPointIds"],
        )?;
        nonempty(&spec["title"])?;
        let preserved = preserve_titles
            && current["slideSpecs"]["value"]
                .as_array()
                .is_some_and(|old| {
                    old.iter()
                        .any(|entry| entry["id"] == page["id"] && entry["title"] == spec["title"])
                });
        if page["id"] != spec["id"] || (page["title"] != spec["title"] && !preserved) {
            return Err("Revision page identifiers, titles or order differ".into());
        }
        completed(&spec["imageGenerationBrief"])?;
        if !strings(&spec["body"])?
            .iter()
            .any(|p| !p.as_str().unwrap().trim().is_empty())
        {
            return Err("Revision body is incomplete".into());
        }
        for (field, ids) in [
            ("sourceIds", &sources),
            ("findingIds", &findings),
            ("dataPointIds", &data),
        ] {
            if let Some(value) = page.get(field) {
                references(value, ids)?;
            }
            if field != "sourceIds" {
                if let Some(value) = spec.get(field) {
                    references(value, ids)?;
                }
            }
        }
        for citation in array(&spec["sourceMap"])? {
            keys(citation, &["sourceId", "title", "locator"], &["url"])?;
            identifier(&citation["sourceId"])?;
            if !sources.contains(string(&citation["sourceId"])?) {
                return Err("Unknown citation source".into());
            }
            nonempty(&citation["title"])?;
            nonempty(&citation["locator"])?;
            if let Some(url) = citation.get("url") {
                nonempty(url)?;
            }
        }
        let mut nested = HashSet::new();
        for table in array(&spec["tables"])? {
            keys(table, &["id", "headers", "rows"], &[])?;
            unique_id(&table["id"], &mut nested)?;
            let columns = strings(&table["headers"])?.len();
            for row in array(&table["rows"])? {
                if strings(row)?.len() != columns {
                    return Err("Invalid revision table row".into());
                }
            }
        }
        for chart in array(&spec["charts"])? {
            keys(chart, &["id", "type", "categories", "series"], &[])?;
            unique_id(&chart["id"], &mut nested)?;
            if !["bar", "line", "pie"].contains(&string(&chart["type"])?) {
                return Err("Invalid chart type".into());
            }
            let categories = strings(&chart["categories"])?.len();
            for series in array(&chart["series"])? {
                keys(series, &["name", "values"], &[])?;
                string(&series["name"])?;
                let values = array(&series["values"])?;
                if values.len() != categories
                    || values
                        .iter()
                        .any(|v| !v.as_f64().is_some_and(f64::is_finite))
                {
                    return Err("Invalid chart series".into());
                }
            }
        }
        for shape in array(&spec["shapes"])? {
            keys(
                shape,
                &["id", "type", "x", "y", "w", "h"],
                &["fill", "line", "text"],
            )?;
            unique_id(&shape["id"], &mut nested)?;
            if !["rect", "ellipse", "line"].contains(&string(&shape["type"])?)
                || ["x", "y", "w", "h"].iter().any(|key| {
                    !shape[key]
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && n >= 0.0)
                })
            {
                return Err("Invalid shape geometry".into());
            }
            for key in ["fill", "line", "text"] {
                if let Some(value) = shape.get(key) {
                    string(value)?;
                }
            }
        }
    }
    Ok(())
}
