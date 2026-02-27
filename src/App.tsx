import { useEffect, useState } from "react";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import LandingPage from "./LandingPage";
import SchwabMarketInfo from "./SchwabMarketInfo";
import TastyAuthPage from "./TastyAuthPage";
import TastyAuthPopupPage from "./TastyAuthPopupPage";
import TastyChart from "./TastyChart";
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
    return <LandingPage />;
  }

  if (pathname === "/app") {
    return (
      <Authenticator>
        <TodoPage />
      </Authenticator>
    );
  }

  if (pathname === "/schwab-market-info") {
    return (
      <Authenticator>
        <SchwabMarketInfo />
      </Authenticator>
    );
  }

  if (pathname === "/tasty-chart" || pathname === "/tasty-market-info") {
    return (
      <Authenticator>
        <TastyChart />
      </Authenticator>
    );
  }

  if (pathname === "/tasty-auth") {
    return (
      <Authenticator>
        <TastyAuthPage />
      </Authenticator>
    );
  }

  if (pathname === "/tasty-auth-popup") {
    return (
      <Authenticator>
        <TastyAuthPopupPage />
      </Authenticator>
    );
  }

  return <NotFoundPage />;
}

export default App;
