//! Capacity is reserved before capture and retained through publication/review.
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[derive(Default)]
pub(super) struct PreparationCapacity(Arc<AtomicUsize>);
pub(super) struct PreparationReservation(Arc<AtomicUsize>);
impl PreparationCapacity {
    pub(super) fn reserve(&self) -> Result<PreparationReservation, String> {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 2).then_some(n + 1)
            })
            .map_err(|_| {
                "two preparations are in progress or awaiting publication; discard one first"
            })?;
        Ok(PreparationReservation(self.0.clone()))
    }
}
impl Drop for PreparationReservation {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
