import { Navigate } from 'react-router-dom';
import { isLoggedIn, isAdmin, getEmail, clearAllTokens } from '../utils/auth';

export default function ProtectedRoute({ children, adminOnly = false, allowedEmails = null }) {
  if (!isLoggedIn()) {
    clearAllTokens();
    return <Navigate to="/login" replace />;
  }
  if (adminOnly && !isAdmin()) {
    return <Navigate to="/" replace />;
  }
  if (allowedEmails && !allowedEmails.includes((getEmail() || '').toLowerCase().trim())) {
    return <Navigate to="/" replace />;
  }
  return children;
}
