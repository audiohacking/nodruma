#include "test_assert.hpp"

#include "nodruma/engine.hpp"
#include "nodruma/model.hpp"
#include "nodruma/session.hpp"

#include <cmath>
#include <numbers>
#include <vector>

/// Process + morph smoke without external audio assets.
void test_reference_fixtures() {
  const double sr = 44100.0;
  const std::size_t n = 12000;
  nodruma::AudioBuffer buf(n, 1, sr);
  float* x = buf.channel(0);
  for (std::size_t i = 0; i < n; ++i) {
    const float t = static_cast<float>(i) / static_cast<float>(sr);
    x[i] = std::exp(-t * 8.f) * std::sin(2.f * std::numbers::pi_v<float> * 55.f * t);
  }

  nodruma::Engine eng;
  nodruma::Session session;
  session.set_model(nodruma::create_model("kick"));
  session.set_input(buf);
  auto out = eng.process(session);
  CHECK(!out.empty());
  CHECK(session.cache().valid);
  CHECK(session.cache().onset.primary_onset >= 0);

  auto p = session.params();
  p.foundation_gain = 1.3f;
  session.set_params(p);
  auto morph = eng.resynthesize(session);
  CHECK(!morph.empty());
  CHECK(morph.num_frames() == out.num_frames());
}
