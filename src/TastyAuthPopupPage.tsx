import { useEffect, useMemo, useState } from "react";
import outputs from "../amplify_outputs.json";

function TastyAuthPopupPage() {
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
      setStatus("TastyTrade connected. Closing window...");
      window.opener?.postMessage({ source: "tasty-oauth", status: "success" }, window.location.origin);
      window.setTimeout(() => window.close(), 200);
      return;
    }

    if (oauth === "error") {
      const errorMessage = message ?? "TastyTrade sign-in failed.";
      setStatus(errorMessage);
      window.opener?.postMessage(
        { source: "tasty-oauth", status: "error", message: errorMessage },
        window.location.origin,
      );
      return;
    }

    if (!apiBaseUrl) {
      setStatus("Tasty API URL is not configured.");
      window.opener?.postMessage(
        { source: "tasty-oauth", status: "error", message: "Tasty API URL is not configured." },
        window.location.origin,
      );
      return;
    }

    const returnTo = `${window.location.origin}/tasty-auth-popup`;
    setStatus("Redirecting to TastyTrade sign-in...");
    window.location.assign(
      `${apiBaseUrl}/tasty/authorize?return_to=${encodeURIComponent(returnTo)}`,
    );
  }, [apiBaseUrl]);

  return (
    <main>
      <h1>TastyTrade Sign-In</h1>
      <p>{status}</p>
    </main>
  );
}

export default TastyAuthPopupPage;
