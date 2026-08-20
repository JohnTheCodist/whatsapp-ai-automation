import React from 'react';
import ReactDOM from 'react-dom/client';
import AuthGate from './AuthGate.jsx';
import { installAuthFetch } from './auth.js';
import './index.css';

// Before React renders, so the very first request a screen makes on mount
// already carries the bearer token. Installing it inside a component would
// leave a window where early fetches go out unauthenticated and 401.
installAuthFetch();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>
);
