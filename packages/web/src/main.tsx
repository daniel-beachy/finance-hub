import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { DEMO } from "./api.ts";
import { Shell } from "./components/Shell.tsx";
import { Accounts } from "./pages/Accounts.tsx";
import { Home } from "./pages/Home.tsx";
import { NetWorth } from "./pages/NetWorth.tsx";
import { Review } from "./pages/Review.tsx";
import { Spending } from "./pages/Spending.tsx";
import { Transactions } from "./pages/Transactions.tsx";
import "./index.css";

// In the demo nothing changes behind the page's back, so nothing is refetched on focus.
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: !DEMO } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Shell>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/review" element={<Review />} />
            <Route path="/spending" element={<Spending />} />
            <Route path="/net-worth" element={<NetWorth />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
