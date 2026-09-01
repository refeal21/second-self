use digital_twin_desktop_lib::database::Database;

#[test]
fn creates_all_workbench_domain_tables() {
    let database = Database::open_in_memory().expect("in-memory database opens");

    assert_eq!(
        database.table_names().expect("table names read"),
        vec![
            "approvals",
            "artifacts",
            "memory_proposals",
            "projects",
            "tasks",
            "versions",
        ]
    );
}
