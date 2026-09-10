use super::PresalesDraftPair;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const NATIVE_VALUE_HASH_ALGORITHM: &str = "native-json-sha256-v1";

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_DEPTH: usize = 32;
const MAX_DESCRIPTION_UTF16: usize = 20_000;

type Check = Result<(), String>;

struct Evidence<'a> {
    findings: HashSet<&'a str>,
    points: HashSet<&'a str>,
    sources: HashSet<&'a str>,
}

fn object<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))
}

fn exact_keys(value: &Value, required: &[&str], optional: &[&str], field: &str) -> Check {
    let value = object(value, field)?;
    if required.iter().any(|key| !value.contains_key(*key)) {
        return Err(format!("{field} has missing fields"));
    }
    if value
        .keys()
        .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(format!("{field} has unknown fields"));
    }
    Ok(())
}

fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("{field} must be a string"))?;
    if value.encode_utf16().count() > MAX_DESCRIPTION_UTF16 {
        return Err(format!("{field} exceeds 20,000 UTF-16 units"));
    }
    Ok(value)
}

fn identifier<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    let value = text(value, field)?;
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 64
        || !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit()
        || !bytes[bytes.len() - 1].is_ascii_lowercase() && !bytes[bytes.len() - 1].is_ascii_digit()
        || !bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-' || *byte == b'_'
        })
    {
        return Err(format!("{field} must be a strict identifier"));
    }
    Ok(value)
}

fn array<'a>(
    value: &'a Value,
    field: &str,
    maximum: Option<usize>,
) -> Result<&'a Vec<Value>, String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("{field} must be an array"))?;
    if maximum.is_some_and(|maximum| values.len() > maximum) {
        return Err(format!("At most {} {field} are allowed", maximum.unwrap()));
    }
    Ok(values)
}

fn strings<'a>(value: &'a Value, field: &str) -> Result<Vec<&'a str>, String> {
    array(value, field, None)?
        .iter()
        .map(|value| text(value, field))
        .collect()
}

fn identifier_strings<'a>(value: &'a Value, field: &str) -> Result<Vec<&'a str>, String> {
    array(value, field, None)?
        .iter()
        .map(|value| identifier(value, field))
        .collect()
}

fn identifiers<'a>(value: &'a Value, field: &str) -> Result<Vec<&'a str>, String> {
    let values = identifier_strings(value, field)?;
    unique(values.iter().copied(), field)?;
    Ok(values)
}

fn unique<'a>(values: impl IntoIterator<Item = &'a str>, field: &str) -> Check {
    let mut seen = HashSet::new();
    if values.into_iter().any(|value| !seen.insert(value)) {
        return Err(format!("{field} must be unique"));
    }
    Ok(())
}

fn references(values: &[&str], known: &HashSet<&str>, field: &str) -> Check {
    if let Some(value) = values.iter().find(|value| !known.contains(**value)) {
        return Err(format!("Unknown {field}: {value}"));
    }
    Ok(())
}

fn optional_identifiers<'a>(
    value: &'a Value,
    field: &str,
    label: &str,
) -> Result<Vec<&'a str>, String> {
    match object(value, label)?.get(field) {
        Some(value) => identifiers(value, field),
        None => Ok(Vec::new()),
    }
}

fn version(value: &Value) -> Check {
    if value.as_u64() != Some(1) {
        return Err("schemaVersion must be 1".into());
    }
    Ok(())
}

fn finite(value: &Value, field: &str) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| format!("{field} must be a finite number"))
}

fn check_payload(value: &Value, field: &str) -> Check {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("{field} exceeds 2 MiB"));
    }
    fn depth(value: &Value, level: usize) -> Check {
        match value {
            Value::Array(values) => {
                if level > MAX_DEPTH {
                    return Err("Envelope must contain bounded JSON data".into());
                }
                for value in values {
                    depth(value, level + 1)?;
                }
            }
            Value::Object(values) => {
                if level > MAX_DEPTH {
                    return Err("Envelope must contain bounded JSON data".into());
                }
                for value in values.values() {
                    depth(value, level + 1)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    depth(value, 0)
}

fn validate_citation<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    exact_keys(value, &["sourceId", "title", "locator"], &["url"], field)?;
    let source = identifier(&value["sourceId"], "citation sourceId")?;
    text(&value["title"], "citation title")?;
    text(&value["locator"], "citation locator")?;
    if let Some(url) = object(value, field)?.get("url") {
        text(url, "citation url")?;
    }
    Ok(source)
}

fn validate_analysis(analysis: &Value) -> Result<Evidence<'_>, String> {
    exact_keys(
        analysis,
        &["findings", "dataPoints", "sourceMap"],
        &[],
        "source analysis",
    )?;
    let citations = array(&analysis["sourceMap"], "sourceMap", None)?;
    let mut sources = HashSet::new();
    for citation in citations {
        let source = validate_citation(citation, "source citation")?;
        if !sources.insert(source) {
            return Err("Source analysis citations must be unique".into());
        }
    }

    let mut findings = HashSet::new();
    for finding in array(&analysis["findings"], "findings", None)? {
        exact_keys(finding, &["id", "text", "sourceIds"], &[], "source finding")?;
        let id = identifier(&finding["id"], "source finding id")?;
        if !findings.insert(id) {
            return Err("Source finding identifiers must be unique".into());
        }
        text(&finding["text"], "source finding text")?;
        let source_ids = identifier_strings(&finding["sourceIds"], "source finding sourceIds")?;
        references(&source_ids, &sources, "analysis source")?;
    }

    let mut points = HashSet::new();
    for point in array(&analysis["dataPoints"], "dataPoints", None)? {
        exact_keys(
            point,
            &["id", "label", "value"],
            &["unit", "sourceIds"],
            "source data point",
        )?;
        let id = identifier(&point["id"], "source data point id")?;
        if !points.insert(id) {
            return Err("Source data point identifiers must be unique".into());
        }
        text(&point["label"], "source data point label")?;
        match &point["value"] {
            Value::String(_) => {
                text(&point["value"], "source data point value")?;
            }
            Value::Number(_) => {
                finite(&point["value"], "source data point value")?;
            }
            _ => return Err("Source data point value is invalid".into()),
        }
        if let Some(unit) = object(point, "source data point")?.get("unit") {
            text(unit, "source data point unit")?;
        }
        if let Some(source_ids) = object(point, "source data point")?.get("sourceIds") {
            references(
                &identifier_strings(source_ids, "source data point sourceIds")?,
                &sources,
                "analysis source",
            )?;
        }
    }
    Ok(Evidence {
        findings,
        points,
        sources,
    })
}

fn validate_outline<'a>(
    value: &'a Value,
    known: &Evidence<'a>,
) -> Result<Vec<HashSet<&'a str>>, String> {
    exact_keys(
        value,
        &["schemaVersion", "outline", "plan"],
        &[],
        "outline envelope",
    )?;
    version(&value["schemaVersion"])?;
    let outline = &value["outline"];
    exact_keys(outline, &["title", "slides"], &[], "outline")?;
    text(&outline["title"], "outline title")?;
    let slides = array(&outline["slides"], "pages", Some(100))?;
    if slides.is_empty() {
        return Err("Outline requires pages".into());
    }
    let mut slide_ids = Vec::with_capacity(slides.len());
    for slide in slides {
        exact_keys(
            slide,
            &["id", "title", "purpose"],
            &["sourceIds", "findingIds", "dataPointIds"],
            "outline slide",
        )?;
        slide_ids.push(identifier(&slide["id"], "slide id")?);
        text(&slide["title"], "slide title")?;
        text(&slide["purpose"], "slide purpose")?;
        references(
            &optional_identifiers(slide, "sourceIds", "outline slide")?,
            &known.sources,
            "source",
        )?;
        references(
            &optional_identifiers(slide, "findingIds", "outline slide")?,
            &known.findings,
            "finding",
        )?;
        references(
            &optional_identifiers(slide, "dataPointIds", "outline slide")?,
            &known.points,
            "data point",
        )?;
    }
    unique(slide_ids.iter().copied(), "Outline slide identifiers")?;

    let plan = &value["plan"];
    exact_keys(plan, &["schemaVersion", "modules", "pages"], &[], "plan")?;
    version(&plan["schemaVersion"])?;
    let modules = array(&plan["modules"], "modules", Some(100))?;
    let mut module_ids = Vec::with_capacity(modules.len());
    for module in modules {
        exact_keys(module, &["id", "name", "findingIds"], &[], "module")?;
        module_ids.push(identifier(&module["id"], "module id")?);
        text(&module["name"], "module name")?;
        references(
            &identifiers(&module["findingIds"], "module findingIds")?,
            &known.findings,
            "finding",
        )?;
    }
    unique(module_ids.iter().copied(), "Module identifiers")?;
    let module_catalog: HashSet<_> = module_ids.iter().copied().collect();

    let pages = array(&plan["pages"], "pages", Some(100))?;
    if pages.len() != slides.len() {
        return Err("Plan pages and outline must have the same count".into());
    }
    let mut page_ids = Vec::with_capacity(pages.len());
    let mut memberships = Vec::with_capacity(pages.len());
    let mut page_types = Vec::with_capacity(pages.len());
    for page in pages {
        exact_keys(
            page,
            &["slideId", "pageType", "keyMessage", "moduleIds"],
            &[],
            "page",
        )?;
        page_ids.push(identifier(&page["slideId"], "page slideId")?);
        let page_type = text(&page["pageType"], "pageType")?;
        if ![
            "cover",
            "goals",
            "architecture",
            "overview",
            "module",
            "scenario",
            "closing",
        ]
        .contains(&page_type)
        {
            return Err("pageType is invalid".into());
        }
        page_types.push(page_type);
        text(&page["keyMessage"], "keyMessage")?;
        let membership = identifiers(&page["moduleIds"], "page moduleIds")?;
        references(&membership, &module_catalog, "module")?;
        memberships.push(membership.into_iter().collect::<HashSet<_>>());
    }
    unique(page_ids.iter().copied(), "Page identifiers")?;
    for (index, page_id) in page_ids.iter().enumerate() {
        if page_id != &slide_ids[index] {
            return Err("Plan pages must match outline identifiers and order".into());
        }
        if ["architecture", "overview"].contains(&page_types[index]) {
            if memberships[index].len() != module_catalog.len() {
                return Err("Architecture and overview must include every module".into());
            }
            for module in &memberships[index] {
                if !(index + 1..pages.len()).any(|later| {
                    ["module", "scenario"].contains(&page_types[later])
                        && memberships[later].contains(module)
                }) {
                    return Err(format!("{module} requires a later module or scenario page"));
                }
            }
        }
    }
    for module in module_ids {
        if !(0..pages.len()).any(|index| {
            ["module", "scenario"].contains(&page_types[index])
                && memberships[index].contains(module)
        }) {
            return Err(format!(
                "{module} requires coverage by a module or scenario page"
            ));
        }
    }
    Ok(memberships)
}

fn validate_table<'a>(value: &'a Value) -> Result<&'a str, String> {
    exact_keys(value, &["id", "headers", "rows"], &[], "table")?;
    let id = identifier(&value["id"], "table id")?;
    let headers = strings(&value["headers"], "table headers")?;
    for row in array(&value["rows"], "table rows", None)? {
        if strings(row, "table row")?.len() != headers.len() {
            return Err("Table row width must match headers".into());
        }
    }
    Ok(id)
}

fn validate_chart<'a>(value: &'a Value) -> Result<&'a str, String> {
    exact_keys(value, &["id", "type", "categories", "series"], &[], "chart")?;
    let id = identifier(&value["id"], "chart id")?;
    let chart_type = text(&value["type"], "chart type")?;
    if !["bar", "line", "pie"].contains(&chart_type) {
        return Err("chart type is invalid".into());
    }
    let categories = strings(&value["categories"], "chart categories")?;
    for series in array(&value["series"], "chart series", None)? {
        exact_keys(series, &["name", "values"], &[], "chart series")?;
        text(&series["name"], "chart series name")?;
        let values = array(&series["values"], "chart values", None)?;
        if values.len() != categories.len() {
            return Err("Chart series width must match categories".into());
        }
        for value in values {
            finite(value, "chart values")?;
        }
    }
    Ok(id)
}

fn validate_shape<'a>(value: &'a Value) -> Result<&'a str, String> {
    exact_keys(
        value,
        &["id", "type", "x", "y", "w", "h"],
        &["fill", "line", "text"],
        "shape",
    )?;
    let id = identifier(&value["id"], "shape id")?;
    if !["rect", "ellipse", "line"].contains(&text(&value["type"], "shape type")?) {
        return Err("shape type is invalid".into());
    }
    for field in ["x", "y", "w", "h"] {
        if finite(&value[field], &format!("shape {field}"))? < 0.0 {
            return Err("Shape geometry must be nonnegative".into());
        }
    }
    for field in ["fill", "line", "text"] {
        if let Some(value) = object(value, "shape")?.get(field) {
            text(value, &format!("shape {field}"))?;
        }
    }
    Ok(id)
}

fn validate_spec<'a>(value: &'a Value, known: &Evidence<'a>) -> Check {
    exact_keys(
        value,
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
        "slide spec",
    )?;
    identifier(&value["id"], "slide spec id")?;
    text(&value["title"], "slide title")?;
    strings(&value["body"], "body")?;
    references(
        &optional_identifiers(value, "findingIds", "slide spec")?,
        &known.findings,
        "finding",
    )?;
    references(
        &optional_identifiers(value, "dataPointIds", "slide spec")?,
        &known.points,
        "data point",
    )?;
    let mut nested_ids = Vec::new();
    for table in array(&value["tables"], "tables", None)? {
        nested_ids.push(validate_table(table)?);
    }
    for chart in array(&value["charts"], "charts", None)? {
        nested_ids.push(validate_chart(chart)?);
    }
    for shape in array(&value["shapes"], "shapes", None)? {
        nested_ids.push(validate_shape(shape)?);
    }
    unique(nested_ids, "Slide nested identifiers")?;
    let mut citation_ids = Vec::new();
    for citation in array(&value["sourceMap"], "sourceMap", None)? {
        citation_ids.push(validate_citation(citation, "source citation")?);
    }
    unique(citation_ids.iter().copied(), "Source citation identifiers")?;
    references(&citation_ids, &known.sources, "source")?;
    text(&value["imageGenerationBrief"], "imageGenerationBrief")?;
    Ok(())
}

fn validate_design(value: &Value) -> Check {
    exact_keys(
        value,
        &[
            "slideId",
            "layout",
            "visualFocus",
            "speakerNotes",
            "textBindings",
            "scene",
        ],
        &[],
        "design",
    )?;
    identifier(&value["slideId"], "design slideId")?;
    text(&value["layout"], "layout")?;
    text(&value["visualFocus"], "visualFocus")?;
    text(&value["speakerNotes"], "speakerNotes")?;
    let bindings = array(&value["textBindings"], "text bindings", Some(100))?;
    let mut binding_ids = Vec::new();
    let mut binding_paths = Vec::new();
    for binding in bindings {
        exact_keys(binding, &["id", "path"], &[], "binding")?;
        binding_ids.push(identifier(&binding["id"], "binding id")?);
        binding_paths.push(text(&binding["path"], "binding path")?);
    }
    unique(binding_ids.iter().copied(), "Binding identifiers")?;
    unique(binding_paths.iter().copied(), "Binding paths")?;
    let binding_ids: HashSet<_> = binding_ids.into_iter().collect();

    if !value["scene"].is_null() {
        let scene = &value["scene"];
        exact_keys(scene, &["steps", "edges"], &[], "scene")?;
        let steps = array(&scene["steps"], "scene steps", Some(100))?;
        let mut step_ids = Vec::new();
        for step in steps {
            exact_keys(
                step,
                &[
                    "id",
                    "moduleId",
                    "actor",
                    "location",
                    "triggerRef",
                    "actionRef",
                    "responseRef",
                    "outcomeRef",
                ],
                &[],
                "scene step",
            )?;
            step_ids.push(identifier(&step["id"], "scene step id")?);
            identifier(&step["moduleId"], "scene moduleId")?;
            text(&step["actor"], "actor")?;
            text(&step["location"], "location")?;
            for field in ["triggerRef", "actionRef", "responseRef", "outcomeRef"] {
                let reference = identifier(&step[field], &format!("scene {field}"))?;
                if !binding_ids.contains(reference) {
                    return Err(format!("Scene {field} references an absent binding"));
                }
            }
        }
        unique(step_ids.iter().copied(), "Scene step identifiers")?;
        let step_ids: HashSet<_> = step_ids.into_iter().collect();
        let mut edges = Vec::new();
        for edge in array(&scene["edges"], "scene edges", Some(400))? {
            exact_keys(edge, &["from", "to"], &[], "scene edge")?;
            let from = identifier(&edge["from"], "scene edge from")?;
            let to = identifier(&edge["to"], "scene edge to")?;
            if !step_ids.contains(from) || !step_ids.contains(to) {
                return Err("Scene edge references an unknown step".into());
            }
            if from == to {
                return Err("Scene cannot contain a self edge".into());
            }
            edges.push((from, to));
        }
        let mut seen = HashSet::new();
        if edges.into_iter().any(|edge| !seen.insert(edge)) {
            return Err("Scene edges must be unique".into());
        }
    }
    Ok(())
}

fn visible_paths(spec: &Value) -> Result<HashSet<String>, String> {
    let mut paths = HashSet::from(["/title".to_owned()]);
    for index in 0..array(&spec["body"], "body", None)?.len() {
        paths.insert(format!("/body/{index}"));
    }
    for (table_index, table) in array(&spec["tables"], "tables", None)?.iter().enumerate() {
        for column in 0..array(&table["headers"], "table headers", None)?.len() {
            paths.insert(format!("/tables/{table_index}/headers/{column}"));
        }
        for (row_index, row) in array(&table["rows"], "table rows", None)?
            .iter()
            .enumerate()
        {
            for column in 0..array(row, "table row", None)?.len() {
                paths.insert(format!("/tables/{table_index}/rows/{row_index}/{column}"));
            }
        }
    }
    for (chart_index, chart) in array(&spec["charts"], "charts", None)?.iter().enumerate() {
        for category in 0..array(&chart["categories"], "chart categories", None)?.len() {
            paths.insert(format!("/charts/{chart_index}/categories/{category}"));
        }
        for (series_index, series) in array(&chart["series"], "chart series", None)?
            .iter()
            .enumerate()
        {
            paths.insert(format!("/charts/{chart_index}/series/{series_index}/name"));
            for value in 0..array(&series["values"], "chart values", None)?.len() {
                paths.insert(format!(
                    "/charts/{chart_index}/series/{series_index}/values/{value}"
                ));
            }
        }
    }
    for (shape_index, shape) in array(&spec["shapes"], "shapes", None)?.iter().enumerate() {
        if object(shape, "shape")?.contains_key("text") {
            paths.insert(format!("/shapes/{shape_index}/text"));
        }
    }
    Ok(paths)
}

fn validate_details<'a>(
    value: &'a Value,
    outline: &'a Value,
    known: &Evidence<'a>,
    memberships: &[HashSet<&'a str>],
) -> Check {
    exact_keys(
        value,
        &["schemaVersion", "specs", "designs"],
        &[],
        "details envelope",
    )?;
    version(&value["schemaVersion"])?;
    let specs = array(&value["specs"], "pages", Some(100))?;
    let designs = array(&value["designs"], "pages", Some(100))?;
    let slides = array(&outline["outline"]["slides"], "pages", Some(100))?;
    if specs.len() != slides.len() || designs.len() != specs.len() {
        return Err("Details and outline page count must match".into());
    }
    for spec in specs {
        validate_spec(spec, known)?;
    }
    for design in designs {
        validate_design(design)?;
    }
    unique(
        specs.iter().map(|spec| spec["id"].as_str().unwrap()),
        "Slide spec identifiers",
    )?;
    unique(
        designs
            .iter()
            .map(|design| design["slideId"].as_str().unwrap()),
        "Design identifiers",
    )?;
    for index in 0..specs.len() {
        let spec = &specs[index];
        let design = &designs[index];
        let slide = &slides[index];
        if spec["id"] != slide["id"] || design["slideId"] != slide["id"] {
            return Err("Details must preserve outline identifiers and order".into());
        }
        if spec["title"] != slide["title"] {
            return Err("Details title must match outline title".into());
        }
        let paths = visible_paths(spec)?;
        let bound: HashSet<_> = array(&design["textBindings"], "text bindings", Some(100))?
            .iter()
            .map(|binding| binding["path"].as_str().unwrap().to_owned())
            .collect();
        if bound.iter().any(|path| !paths.contains(path)) {
            return Err("Unsupported visible binding path".into());
        }
        if bound != paths {
            return Err("Every visible leaf requires exactly one binding".into());
        }
        if let Some(steps) = design["scene"].get("steps").and_then(Value::as_array) {
            for step in steps {
                let module = step["moduleId"].as_str().unwrap();
                if !memberships[index].contains(module) {
                    return Err("Scene moduleId is outside page membership".into());
                }
            }
        }
    }
    Ok(())
}

pub fn validate_pair(pair: &PresalesDraftPair, analysis: &Value) -> Check {
    if pair.schema_version != 1 {
        return Err("schemaVersion must be 1".into());
    }
    check_payload(&pair.outline, "Outline envelope")?;
    if let Some(details) = &pair.details {
        check_payload(details, "Details envelope")?;
    }
    let evidence = validate_analysis(analysis)?;
    let memberships = validate_outline(&pair.outline, &evidence)?;
    if let Some(details) = &pair.details {
        validate_details(details, &pair.outline, &evidence, &memberships)?;
    }
    Ok(())
}

fn write_canonical(value: &Value, output: &mut Vec<u8>) -> Check {
    match value {
        Value::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                write_canonical(value, output)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            output.push(b'{');
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                serde_json::to_writer(&mut *output, key).map_err(|error| error.to_string())?;
                output.push(b':');
                write_canonical(&values[key], output)?;
            }
            output.push(b'}');
        }
        _ => serde_json::to_writer(&mut *output, value).map_err(|error| error.to_string())?,
    }
    Ok(())
}

pub fn native_value_hash(value: &Value) -> Result<String, String> {
    let mut bytes = Vec::new();
    write_canonical(value, &mut bytes)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub fn bundled_skill_metadata() -> Value {
    serde_json::from_str(include_str!(
        "../../../../worker/src/presales/skill.metadata.generated.json"
    ))
    .expect("compiled presales skill metadata must be valid JSON")
}
