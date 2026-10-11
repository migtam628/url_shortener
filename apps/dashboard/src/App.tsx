import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Me } from './lib/api';
import { AppShell } from './components/AppShell';
import { Login } from './pages/Login';
import { Links } from './pages/Links';
import { Analytics } from './pages/Analytics';
import { Domains } from './pages/Domains';
import { ApiKeys } from './pages/ApiKeys';
import { Loading } from './components/ui';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/auth/me'),
    retry: false,
  });

  if (me.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Loading label="Checking your session" />
      </div>
    );
  }
  if (me.isError) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/links" element={<Links />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/domains" element={<Domains />} />
        <Route path="/keys" element={<ApiKeys />} />
      </Route>
      <Route path="*" element={<Navigate to="/links" replace />} />
    </Routes>
  );
}
