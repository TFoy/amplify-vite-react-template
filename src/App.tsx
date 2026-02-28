import { useEffect, useState } from "react";
import { Authenticator, useAuthenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import LandingPage from "./LandingPage";
import SchwabMarketInfo from "./SchwabMarketInfo";
import TastyAuthPage from "./TastyAuthPage";
import TastyAuthPopupPage from "./TastyAuthPopupPage";
import TastyChart from "./TastyChart";
import TastyMarketInfo from "./TastyMarketInfo";
import TodoPage from "./TodoPage";

function normalizePath(pathname: string) {
  if (!pathname || pathname === "/") {
    return "/";
  }

  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function NotFoundPage() {
  return (
    <main>
      <h1>Page not found</h1>
      <a href="/">Go to landing page</a>
    </main>
  );
}

function UserMenu() {
  const { user, signOut } = useAuthenticator((context) => [context.user]);
  const [isOpen, setIsOpen] = useState(false);
  const identity = user?.signInDetails?.loginId ?? user?.username ?? "Guest";

  return (
    <div
      style={{
        position: "fixed",
        top: "12px",
        right: "12px",
        zIndex: 1000,
      }}
    >
      <button
        onClick={() => setIsOpen((current) => !current)}
        style={{
          border: "none",
          borderRadius: 0,
          background: "transparent",
          padding: 0,
          color: "#1c1440",
          fontWeight: 700,
          boxShadow: "none",
        }}
        type="button"
      >
        {user ? identity : "sign on"}
      </button>
      {isOpen ? (
        <div
          style={{
            marginTop: "8px",
            width: user ? "220px" : "360px",
            border: "1px solid rgba(0, 0, 0, 0.18)",
            borderRadius: "12px",
            background: "white",
            padding: "12px",
            boxShadow: "0 12px 32px rgba(0, 0, 0, 0.18)",
            position: "absolute",
            right: 0,
          }}
        >
          {user ? (
            <>
              <p style={{ marginTop: 0 }}>{identity}</p>
              <button onClick={signOut} type="button">
                Sign out
              </button>
            </>
          ) : (
            <Authenticator initialState="signIn" />
          )}
        </div>
      ) : null}
    </div>
  );
}

function SiteFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <UserMenu />
      <div style={{ paddingTop: "56px" }}>{children}</div>
    </>
  );
}

function App() {
  const [pathname, setPathname] = useState(() =>
    normalizePath(window.location.pathname),
  );

  useEffect(() => {
    const onNavigation = () => {
      setPathname(normalizePath(window.location.pathname));
    };

    window.addEventListener("popstate", onNavigation);
    return () => window.removeEventListener("popstate", onNavigation);
  }, []);

  if (pathname === "/") {
    return (
      <SiteFrame>
        <LandingPage />
      </SiteFrame>
    );
  }

  if (pathname === "/app") {
    return (
      <SiteFrame>
        <TodoPage />
      </SiteFrame>
    );
  }

  if (pathname === "/schwab-market-info") {
    return (
      <SiteFrame>
        <SchwabMarketInfo />
      </SiteFrame>
    );
  }

  if (pathname === "/tasty-chart") {
    return (
      <SiteFrame>
        <TastyChart />
      </SiteFrame>
    );
  }

  if (pathname === "/tasty-market-info") {
    return (
      <SiteFrame>
        <TastyMarketInfo />
      </SiteFrame>
    );
  }

  if (pathname === "/tasty-auth") {
    return (
      <SiteFrame>
        <TastyAuthPage />
      </SiteFrame>
    );
  }

  if (pathname === "/tasty-auth-popup") {
    return (
      <SiteFrame>
        <TastyAuthPopupPage />
      </SiteFrame>
    );
  }

  return (
    <SiteFrame>
      <NotFoundPage />
    </SiteFrame>
  );
}

export default App;
