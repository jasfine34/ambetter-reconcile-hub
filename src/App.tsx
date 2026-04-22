import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BatchProvider } from "@/contexts/BatchContext";
import { AppLayout } from "@/components/AppLayout";
import DashboardPage from "./pages/DashboardPage";
import UploadPage from "./pages/UploadPage";
import ExceptionsPage from "./pages/ExceptionsPage";
import AgentSummaryPage from "./pages/AgentSummaryPage";
import EntitySummaryPage from "./pages/EntitySummaryPage";
import ManualMatchPage from "./pages/ManualMatchPage";
import AllRecordsPage from "./pages/AllRecordsPage";
import MemberTimelinePage from "./pages/MemberTimelinePage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <BatchProvider>
          <AppLayout>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/upload" element={<UploadPage />} />
              <Route path="/exceptions" element={<ExceptionsPage />} />
              <Route path="/agents" element={<AgentSummaryPage />} />
              <Route path="/entities" element={<EntitySummaryPage />} />
              <Route path="/manual-match" element={<ManualMatchPage />} />
              <Route path="/records" element={<AllRecordsPage />} />
              <Route path="/member-timeline" element={<MemberTimelinePage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </AppLayout>
        </BatchProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
