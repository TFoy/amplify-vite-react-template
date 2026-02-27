import { useEffect, useMemo, useState } from "react";
import outputs from "../amplify_outputs.json";

function TastyAuthPage() {
  const [status, setStatus] = useState("Preparing TastyTrade sign-in...");

  const apiBaseUrl = useMemo(() => {
    const configUrl =
      (outputs as { custom?: { tasty?: { api_url?: string } } }).custom?.tasty?.api_url ??
      import.meta.env.VITE_TASTY_API_URL;

    return configUrl?.replace(/\/$/, "") ?? "";
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    const message = params.get("message");

    if (oauth === "success") {
      setStatus("TastyTrade connected. Returning to chart...");
      window.setTimeout(() => {
        window.location.assign("/tasty-chart");
      }, 1200);
      return;
    }

    if (oauth === "error") {
      setStatus(message ?? "TastyTrade sign-in failed.");
      return;
    }

    if (!apiBaseUrl) {
      setStatus("Tasty API URL is not configured.");
      return;
    }

    const returnTo = `${window.location.origin}/tasty-auth`;
    setStatus("Redirecting to TastyTrade sign-in...");
    window.location.assign(
      `${apiBaseUrl}/tasty/authorize?return_to=${encodeURIComponent(returnTo)}`,
    );
  }, [apiBaseUrl]);

  return (
    <main>
      <a href="/tasty-chart">Back to Tasty chart</a>
      <h1>TastyTrade Sign-In</h1>
      <p>{status}</p>
    </main>
  );
}

export default TastyAuthPage;
