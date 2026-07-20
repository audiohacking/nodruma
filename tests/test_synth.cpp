#include "test_assert.hpp"

#include "nodruma/engine.hpp"
#include "nodruma/model.hpp"
#include "nodruma/params.hpp"
#include "nodruma/session.hpp"

#include <cmath>
#include <numbers>

void test_synth() {
  const double sr = 44100.0;
  const std::size_t n = 16000;
  nodruma::AudioBuffer buf(n, 1, sr);
  float* x = buf.channel(0);
  for (std::size_t i = 0; i < n; ++i) {
    const float t = static_cast<float>(i) / static_cast<float>(sr);
    x[i] = std::exp(-t * 6.f) * std::sin(2.f * std::numbers::pi_v<float> * 60.f * t);
  }

  nodruma::Session session;
  session.set_model(nodruma::create_model("kick"));
  session.set_input(buf);
  nodruma::Engine eng;
  auto out = eng.process(session);
  CHECK(!out.empty());
  CHECK(out.num_channels() == 2);

  // morph path: change gain and resynth without re-analysis
  auto p = session.params();
  p.foundation_gain = 0.2f;
  p.output_gain = 0.5f;
  session.set_params(p);
  auto out2 = eng.resynthesize(session);
  CHECK(out2.num_frames() == out.num_frames());

  float e1 = 0.f, e2 = 0.f;
  for (std::size_t i = 0; i < out.num_frames(); ++i) {
    e1 += std::fabs(out.channel(0)[i]);
    e2 += std::fabs(out2.channel(0)[i]);
  }
  CHECK(e2 < e1);

  // Snare path: mid body + noise should produce audible output (not kick-silence).
  {
    nodruma::AudioBuffer sn(n, 1, sr);
    float* s = sn.channel(0);
    for (std::size_t i = 0; i < n; ++i) {
      const float t = static_cast<float>(i) / static_cast<float>(sr);
      const float noise = static_cast<float>(((i * 1103515245u + 12345u) >> 16) & 0x7fff) /
                              32768.f -
                          0.5f;
      s[i] = std::exp(-t * 25.f) *
             (0.4f * std::sin(2.f * std::numbers::pi_v<float> * 200.f * t) + 0.6f * noise);
    }
    nodruma::Session ss;
    ss.set_model(nodruma::create_model("snare"));
    ss.set_input(sn);
    auto sout = eng.process(ss);
    CHECK(!sout.empty());
    float peak = 0.f;
    for (std::size_t i = 0; i < sout.num_frames(); ++i)
      peak = std::max(peak, std::fabs(sout.channel(0)[i]));
    CHECK(peak > 0.05f);
  }

  // Hat path: short HF burst must stay audible.
  {
    nodruma::AudioBuffer ht(n, 1, sr);
    float* h = ht.channel(0);
    for (std::size_t i = 0; i < 2000; ++i) {
      const float t = static_cast<float>(i) / static_cast<float>(sr);
      const float noise = static_cast<float>(((i * 1664525u + 1013904223u) >> 8) & 0xffff) /
                              65536.f -
                          0.5f;
      h[i] = std::exp(-t * 80.f) * noise;
    }
    nodruma::Session hs;
    hs.set_model(nodruma::create_model("hat"));
    hs.set_input(ht);
    auto hout = eng.process(hs);
    CHECK(!hout.empty());
    float peak = 0.f;
    for (std::size_t i = 0; i < hout.num_frames(); ++i)
      peak = std::max(peak, std::fabs(hout.channel(0)[i]));
    CHECK(peak > 0.05f);
  }
}
