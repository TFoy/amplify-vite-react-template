import { useEffect, useMemo, useState } from "react";
import outputs from "../amplify_outputs.json";
import { getAuthHeaders } from "./auth";

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
        setStatus(error instanceof Error ? error.message : "Unable to start TastyTrade sign-in.");
      }
    })();
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
