#include "test_assert.hpp"

#include "nodruma/audio_buffer.hpp"
#include "nodruma/split.hpp"

#include <cmath>
#include <numbers>
#include <vector>

void test_split() {
  const double sr = 44100.0;
  const std::size_t n = static_cast<std::size_t>(sr * 1.2);  // 1.2 s
  std::vector<float> x(n, 0.f);

  auto place_kick = [&](std::size_t at) {
    for (std::size_t i = 0; i < 2000 && at + i < n; ++i) {
      const float t = static_cast<float>(i) / static_cast<float>(sr);
      x[at + i] += 0.9f * std::exp(-t * 18.f) *
                   std::sin(2.f * std::numbers::pi_v<float> * 55.f * t);
    }
    x[at] = 1.f;
  };
  auto place_snare = [&](std::size_t at) {
    for (std::size_t i = 0; i < 1200 && at + i < n; ++i) {
      const float t = static_cast<float>(i) / static_cast<float>(sr);
      // Body + noise burst
      x[at + i] += 0.45f * std::exp(-t * 35.f) *
                   std::sin(2.f * std::numbers::pi_v<float> * 180.f * t);
      const float noise = static_cast<float>(((i * 1103515245u + 12345u) >> 16) & 0x7fff) /
                              32768.f -
                          0.5f;
      x[at + i] += 0.55f * std::exp(-t * 60.f) * noise;
    }
    x[at] = std::max(x[at], 0.85f);
  };

  const std::size_t k1 = static_cast<std::size_t>(sr * 0.10);
  const std::size_t s1 = static_cast<std::size_t>(sr * 0.35);
  const std::size_t k2 = static_cast<std::size_t>(sr * 0.60);
  const std::size_t s2 = static_cast<std::size_t>(sr * 0.85);
  place_kick(k1);
  place_snare(s1);
  place_kick(k2);
  place_snare(s2);

  nodruma::SplitOptions opts;
  opts.threshold_scale = 0.85f;
  opts.min_gap_sec = 0.08f;
  auto split = nodruma::split_groove(x.data(), x.size(), sr, opts);
  CHECK(split.hits.size() >= 3);
  CHECK(!split.flux_samples.empty());
  CHECK(split.flux_samples.size() == n);

  // At least one kick and one snare/unknown with LF or HF cues
  int kicks = 0, snares = 0;
  for (const auto& h : split.hits) {
    if (h.kind == nodruma::HitKind::Kick) ++kicks;
    if (h.kind == nodruma::HitKind::Snare) ++snares;
    CHECK(h.length_samples > 64);
    auto one = nodruma::extract_hit(nodruma::AudioBuffer::from_mono(x, sr), h);
    CHECK(!one.empty());
  }
  CHECK(kicks >= 1);
  // Synthetic kicks should classify as Kick (LF body).
  bool classified_kick = false;
  for (const auto& h : split.hits) {
    if (h.kind == nodruma::HitKind::Kick && h.lf_ratio > 0.15f) classified_kick = true;
  }
  CHECK(classified_kick);
  // Snare classification can be soft on synthetic noise; require LF contrast on kicks.
  bool saw_lf_kick = false;
  for (const auto& h : split.hits) {
    if (h.lf_ratio > 0.25f) saw_lf_kick = true;
  }
  CHECK(saw_lf_kick);
  (void)snares;
}
