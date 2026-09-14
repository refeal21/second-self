use super::preparation::PreparationCapacity;

#[test]
fn in_flight_reservations_count_before_expensive_preparation_and_release_on_drop() {
    let capacity = PreparationCapacity::default();
    let first = capacity.reserve().unwrap();
    let second = capacity.reserve().unwrap();
    assert!(capacity.reserve().is_err());
    drop(first);
    let replacement = capacity.reserve().unwrap();
    assert!(capacity.reserve().is_err());
    drop((second, replacement));
    assert!(capacity.reserve().is_ok());
}
