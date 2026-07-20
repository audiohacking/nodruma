#include "test_assert.hpp"

#include "nodruma/engine.hpp"
#include "nodruma/model.hpp"
#include "nodruma/session.hpp"
#include "nodruma/wav_io.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <numbers>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace {

fs::path repo_output_dir() {
  const fs::path candidates[] = {
      fs::path("output"),
      fs::path("../output"),
      fs::path("../../output"),
  };
  for (const auto& p : candidates) {
    if (fs::exists(p.parent_path() / "CMakeLists.txt") ||
        fs::exists(p.parent_path() / ".git")) {
      fs::create_directories(p);
      return p;
    }
  }
  fs::create_directories("output");
  return "output";
}

nodruma::AudioBuffer make_kick(std::size_t n, double sr, float f0, float noise_amt,
                               float reverb_amt) {
  nodruma::AudioBuffer buf(n, 1, sr);
  float* x = buf.channel(0);
  const std::size_t hit = n / 8;
  for (std::size_t i = 0; i < n; ++i) {
    const float t =
        static_cast<float>(static_cast<int>(i) - static_cast<int>(hit)) / static_cast<float>(sr);
    float s = 0.f;
    if (t >= 0.f) {
      const float pitch = f0 * std::exp(-t * 3.f);
      s = 0.85f * std::exp(-t * 7.f) *
          std::sin(2.f * std::numbers::pi_v<float> * pitch * t);
      s += noise_amt * std::exp(-t * 60.f) *
           std::sin(2.f * std::numbers::pi_v<float> * 3500.f * t);
    }
    x[i] = s;
  }
  // crude "reverb": decaying echo taps (undefined low-end / smeared transient case)
  if (reverb_amt > 0.f) {
    std::vector<float> y(n);
    for (std::size_t i = 0; i < n; ++i) {
      y[i] = x[i];
      if (i > 2000) y[i] += reverb_amt * 0.45f * x[i - 2000];
      if (i > 4500) y[i] += reverb_amt * 0.25f * x[i - 4500];
    }
    std::copy(y.begin(), y.end(), x);
  }
  return buf;
}

}  // namespace

void test_bench() {
  const double sr = 44100.0;
  const std::size_t n = 44100 * 2;  // 2 seconds

  struct Case {
    const char* name;
    float f0, noise, verb;
  };
  const Case cases[] = {
      {"clean", 55.f, 0.25f, 0.f},
      {"noisy", 50.f, 0.7f, 0.f},
      {"reverb", 48.f, 0.3f, 0.8f},
      {"soft_low", 38.f, 0.15f, 0.3f},
  };

  nodruma::Engine eng;
  for (const auto& c : cases) {
    nodruma::Session session;
    session.set_model(nodruma::create_model("kick"));
    session.set_input(make_kick(n, sr, c.f0, c.noise, c.verb));

    const auto t0 = std::chrono::steady_clock::now();
    auto out = eng.process(session);
    const auto t1 = std::chrono::steady_clock::now();
    auto p = session.params();
    p.tone_gain = 0.3f;
    p.foundation_pitch_scale = 1.2f;
    session.set_params(p);
    auto out2 = eng.resynthesize(session);
    const auto t2 = std::chrono::steady_clock::now();

    const auto full_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    const auto morph_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(t2 - t1).count();

    std::cout << "bench[" << c.name << "] full_ms=" << full_ms << " morph_ms=" << morph_ms
              << '\n';

    CHECK(!out.empty());
    CHECK(!out2.empty());
    CHECK(session.cache().valid);
    // Full process should be comfortably sub-second on 2s audio for this CPU class
    CHECK(full_ms < 5000);
    // Morph path should be faster than full process
    CHECK(morph_ms <= full_ms);
  }

  // Multi-model smoke
  for (const char* mid : {"kick", "snare", "hat"}) {
    nodruma::Session session;
    session.set_model(nodruma::create_model(mid));
    session.set_input(make_kick(8000, sr, 60.f, 0.4f, 0.f));
    auto out = eng.process(session);
    CHECK(!out.empty());
  }

  // Session cache round-trip (writes under ./output, gitignored)
  {
    nodruma::Session session;
    session.set_model(nodruma::create_model("kick"));
    session.set_input(make_kick(8000, sr, 55.f, 0.2f, 0.f));
    eng.analyze_and_extract(session);
    const auto path = (repo_output_dir() / "nodruma_test_cache.bin").string();
    CHECK(session.save_cache(path));
    nodruma::Session loaded;
    loaded.set_model(nodruma::create_model("kick"));
    CHECK(loaded.load_cache(path));
    auto out = eng.resynthesize(loaded);
    CHECK(!out.empty());
  }
}
