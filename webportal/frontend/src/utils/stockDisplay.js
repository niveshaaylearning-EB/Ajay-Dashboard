// LIQUIDCASE is a synthetic nseCode the backend (persistence.py's
// _reconcile_liquidcase) auto-fills with a basket's unallocated capital so
// every client always sums to 100% -- it isn't a real tradeable stock, so
// every READ-ONLY display of a stock's code/name should show "Cash" instead.
// Editable inputs (the admin's own ticker field when adding/editing a
// holding) intentionally keep showing the raw code, since that's the actual
// stored value being edited.
export const LIQUIDCASE_CODE = 'LIQUIDCASE';
export const displayNseCode = (code) => (code === LIQUIDCASE_CODE ? 'Cash' : code);
