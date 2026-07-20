#include "test_assert.hpp"

#include "nodruma/engine.hpp"
#include "nodruma/model.hpp"
#include "nodruma/session.hpp"

#include <cmath>
#include <numbers>
#include <vector>

void test_extract() {
  const double sr = 44100.0;
  const std::size_t n = 22050;
  nodruma::AudioBuffer buf(n, 1, sr);
  float* x = buf.channel(0);
  const std::size_t hit = 2000;
  for (std::size_t i = 0; i < n; ++i) {
    const float t = static_cast<float>(static_cast<int>(i) - static_cast<int>(hit)) /
                    static_cast<float>(sr);
    if (t < 0.f) {
      x[i] = 0.f;
      continue;
    }
    // synthetic kick: decaying sine + click
    x[i] = 0.8f * std::exp(-t * 8.f) *
               std::sin(2.f * std::numbers::pi_v<float> * 55.f * t) +
           0.3f * std::exp(-t * 80.f) *
               std::sin(2.f * std::numbers::pi_v<float> * 2000.f * t);
  }

  nodruma::Session session;
  session.set_model(nodruma::create_model("kick"));
  session.set_input(buf);
  nodruma::Engine eng;
  eng.analyze_and_extract(session);
  CHECK(session.cache().valid);
  CHECK(session.cache().layers.foundation.num_frames() == n);
  float energy = 0.f;
  for (std::size_t i = 0; i < n; ++i)
    energy += std::fabs(session.cache().layers.foundation.channel(0)[i]);
  CHECK(energy > 1.f);
}
