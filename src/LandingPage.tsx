import { useState } from "react";
import abstractTraderImage from "./assets/landing/abstract_trader.png";
import aiTraderImage from "./assets/landing/ai_trader.png";

const heroImages = [aiTraderImage, abstractTraderImage];

function LandingPage() {
  const [imageIndex, setImageIndex] = useState(() =>
    Math.floor(Math.random() * heroImages.length),
  );

  const heroImage = heroImages[imageIndex];

  const toggleHeroImage = () => {
    setImageIndex((currentIndex) => (currentIndex + 1) % heroImages.length);
  };

  return (
    <main className="landing-page">
      <section className="landing-hero">
        <div className="landing-copy">
          <p className="landing-kicker">AI Trader Workspace</p>
          <h1>Welcome</h1>
        </div>
        <button
          aria-label="Switch landing image"
          className="landing-image-button"
          onClick={toggleHeroImage}
          type="button"
        >
          <img
            alt="Trader illustration"
            className="landing-image"
            src={heroImage}
          />
        </button>
      </section>
      <nav className="landing-links">
        <a href="/app">Todo</a>
        <a href="/alphavantage-daily">Alpha Vantage Daily</a>
        <a href="/finnhub-quote">Finnhub Quote</a>
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
