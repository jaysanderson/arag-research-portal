import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { TenantPicker } from './pages/TenantPicker.tsx'
import { TenantLayout } from './pages/TenantLayout.tsx'
import { ExplorePage } from './pages/ExplorePage.tsx'
import { SearchPage } from './pages/SearchPage.tsx'
import { AdminPage } from './pages/AdminPage.tsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element #root not found')
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path='/' element={<TenantPicker />} />
          <Route path='/admin' element={<AdminPage />} />
          <Route path='/t/:slug' element={<TenantLayout />}>
            <Route index element={<ExplorePage />} />
            <Route path='search' element={<SearchPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
