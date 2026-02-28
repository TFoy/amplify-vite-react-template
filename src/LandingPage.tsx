import heroImage from "./assets/landing/ai_trader.png";

function LandingPage() {
  return (
    <main className="landing-page">
      <section className="landing-hero">
        <div className="landing-copy">
          <p className="landing-kicker">AI Trader Workspace</p>
          <h1>Welcome</h1>
        </div>
        <img
          alt="AI trader illustration"
          className="landing-image"
          src={heroImage}
        />
      </section>
      <nav className="landing-links">
        <a href="/app">Todo</a>
        <a href="/schwab-market-info">Schwab Market Information</a>
        <a href="/tasty-market-info">Tasty Market Information</a>
        <a href="/tasty-chart">Tasty Chart</a>
        <a href="/html/color_picker.html">Color Selector</a>
        <a href="/html/hiragana_flash.html">Hiragana flash cards</a>
        <a href="/html/katakana_flash.html">Katakana flash cards</a>
        <a href="/html/shavian_flash.html">Shavian flash cards</a>
      </nav>
    </main>
  );
}

export default LandingPage;
