import { useEffect, useMemo, useState } from "react";
import outputs from "../amplify_outputs.json";
import { getAuthHeaders } from "./auth";

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
    void (async () => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/tasty/authorize-url?return_to=${encodeURIComponent(returnTo)}`,
          {
            headers: await getAuthHeaders(),
          },
        );
        const payload = (await response.json()) as { authorizeUrl?: string; error?: string };
        if (!response.ok || !payload.authorizeUrl) {
          throw new Error(payload.error ?? "Unable to start TastyTrade sign-in.");
        }

        window.location.assign(payload.authorizeUrl);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unable to start TastyTrade sign-in.";
        setStatus(errorMessage);
        window.opener?.postMessage(
          { source: "tasty-oauth", status: "error", message: errorMessage },
          window.location.origin,
        );
      }
    })();
  }, [apiBaseUrl]);

  return (
    <main>
      <h1>TastyTrade Sign-In</h1>
      <p>{status}</p>
    </main>
  );
}

export default TastyAuthPopupPage;
