// Single source of truth for "is the current viewer allowed to edit" inside
// the webportal. Reads the `edit` query param the outer app (ActualPortfolio.jsx)
// computes and puts on this iframe's URL -- that's already correctly synced
// with a promoted admin's real status (see frontend/src/utils/auth.js's
// syncAdminStatus()), so pages here should defer to it rather than re-deriving
// admin status themselves from a separately hardcoded email list, which goes
// stale the moment anyone is promoted via the DB (confirmed bug: AllClientsPage,
// BuyPricePage, CalculateReturnPage, CorporateActionsPage and PLStatementPage
// each had their own copy of this exact hardcoded list, independently stale).
const _qp = new URLSearchParams(window.location.search);
export const READ_ONLY = _qp.get('edit') === '0';
export const isAdmin = () => !READ_ONLY;
