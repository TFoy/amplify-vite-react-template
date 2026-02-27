import { useEffect, useState } from "react";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import LandingPage from "./LandingPage";
import MarketInfo from "./MarketInfo";
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

  if (pathname === "/market-info") {
    return (
      <Authenticator>
        <MarketInfo />
      </Authenticator>
    );
  }

  return <NotFoundPage />;
}

export default App;
