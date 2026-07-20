#include "extract.hpp"

#include "stft.hpp"

#include <algorithm>
#include <cmath>
#include <vector>

namespace nodruma::detail {

namespace {

float soft_band_weight(float freq_hz, const BandPrior& prior) {
  const float width = std::max(prior.high_hz - prior.low_hz, 1.f);
  const float edge = width * std::max(prior.softness, 0.05f);
  if (freq_hz < prior.low_hz) {
    const float d = (prior.low_hz - freq_hz) / std::max(edge, 1.f);
    return std::exp(-d * d);
  }
  if (freq_hz > prior.high_hz) {
    const float d = (freq_hz - prior.high_hz) / std::max(edge, 1.f);
    return std::exp(-d * d);
  }
  const float x = (freq_hz - prior.center_hz) / (0.5f * width);
  return std::exp(-x * x * 0.5f);
}

float time_gate(std::size_t sample, std::int64_t onset, double sr, float attack_s, float hold_s,
                float release_s, float tighten) {
  const float t =
      static_cast<float>(static_cast<std::int64_t>(sample) - onset) / static_cast<float>(sr);
  const float atk = std::max(1e-4f, attack_s * tighten);
  const float rel = std::max(1e-4f, release_s / std::max(tighten, 0.1f));
  if (t < -atk) return 0.f;
  if (t < 0.f) return (t + atk) / atk;
  if (t < hold_s) return 1.f;
  const float u = t - hold_s;
  if (u > rel) return 0.f;
  return 1.f - u / rel;
}

AudioBuffer buffer_from_mono(std::vector<float>&& mono, double sr) {
  AudioBuffer buf(mono.size(), 1, sr);
  std::copy(mono.begin(), mono.end(), buf.channel(0));
  return buf;
}

}  // namespace

LayerBuffers extract_layers(const float* mono, std::size_t n, double sample_rate,
                            const OnsetResult& onset, const IModel& model,
                            const ModelParams& params) {
  LayerBuffers layers;
  if (n == 0) return layers;

  const StftConfig cfg = make_extract_stft_config(sample_rate);
  StftData stft = compute_stft(mono, n, sample_rate, cfg);

  const float bin_hz = static_cast<float>(sample_rate) / static_cast<float>(stft.fft_size);
  const auto layers_ids = {LayerId::Transient, LayerId::Foundation, LayerId::Tone,
                           LayerId::Noise,     LayerId::PercNoise};

  struct LayerSpec {
    LayerId id;
    float attack, hold, release;
  };
  const LayerSpec specs[] = {
      {LayerId::Transient, 0.001f, 0.008f, 0.025f},
      {LayerId::Foundation, 0.002f, 0.15f, 0.6f},
      {LayerId::Tone, 0.002f, 0.12f, 0.45f},
      {LayerId::Noise, 0.001f, 0.08f, 0.35f},
      {LayerId::PercNoise, 0.0005f, 0.01f, 0.04f},
  };

  // Hats/snares need shorter gates than kick; kick keeps the long foundation tail.
  float hold_mul = 1.f;
  float rel_mul = 1.f;
  if (model.id() == "hat") {
    hold_mul = 0.22f;
    rel_mul = 0.28f;
  } else if (model.id() == "snare") {
    hold_mul = 0.55f;
    rel_mul = 0.55f;
  }

  std::vector<StftData> masked;
  masked.reserve(5);

  for (const auto& spec : specs) {
    StftData m = stft;
    const BandPrior prior = model.band_prior(spec.id);
    const float hold = spec.hold * hold_mul;
    const float release = spec.release * rel_mul;
    for (int f = 0; f < m.num_frames; ++f) {
      const int center = f * m.hop;
      const float tg = time_gate(static_cast<std::size_t>(std::max(0, center)),
                                 onset.primary_onset, sample_rate, spec.attack, hold,
                                 release * params.body_decay, params.attack_tighten);
      for (int b = 0; b < m.num_bins; ++b) {
        const float freq = bin_hz * static_cast<float>(b);
        float w = soft_band_weight(freq, prior) * tg;
        // tone brightness / noise brightness tweaks
        if (spec.id == LayerId::Tone && params.tone_brightness != 1.f) {
          const float rel = freq / std::max(prior.center_hz, 1.f);
          w *= std::pow(std::max(rel, 0.1f), params.tone_brightness - 1.f);
        }
        if ((spec.id == LayerId::Noise || spec.id == LayerId::PercNoise) &&
            params.noise_brightness != 1.f) {
          const float rel = freq / std::max(prior.center_hz, 1.f);
          w *= std::pow(std::max(rel, 0.1f), params.noise_brightness - 1.f);
        }
        w = std::clamp(w, 0.f, 1.f);
        const std::size_t ci = static_cast<std::size_t>((f * m.num_bins + b) * 2);
        m.complex_ri[ci] *= w;
        m.complex_ri[ci + 1] *= w;
        m.mag[static_cast<std::size_t>(f * m.num_bins + b)] *= w;
      }
    }
    masked.push_back(std::move(m));
  }

  auto recon = [&](const StftData& m) {
    return buffer_from_mono(istft(m, n, sample_rate), sample_rate);
  };

  layers.transient = recon(masked[0]);
  layers.foundation = recon(masked[1]);
  layers.tone = recon(masked[2]);
  layers.noise = recon(masked[3]);
  layers.perc_noise = recon(masked[4]);

  // Residue = input - sum of layers (mono)
  std::vector<float> residue(n, 0.f);
  for (std::size_t i = 0; i < n; ++i) {
    const float sum = layers.transient.channel(0)[i] + layers.foundation.channel(0)[i] +
                      layers.tone.channel(0)[i] + layers.noise.channel(0)[i] +
                      layers.perc_noise.channel(0)[i];
    residue[i] = mono[i] - sum;
  }
  layers.residue = buffer_from_mono(std::move(residue), sample_rate);

  (void)layers_ids;
  return layers;
}

}  // namespace nodruma::detail
