#include "nodruma/model.hpp"

namespace nodruma {

namespace {

class KickAda final : public IModel {
public:
  std::string_view id() const override { return "kick"; }
  std::string_view name() const override { return "kick/ada.1"; }
  std::string_view description() const override {
    return "Kick-tuned model: low foundation sine, click transient, body noise";
  }

  BandPrior band_prior(LayerId layer) const override {
    switch (layer) {
      case LayerId::Transient:
        return {1000.f, 16000.f, 5000.f, 0.35f};
      case LayerId::Foundation:
        return {20.f, 120.f, 55.f, 0.3f};
      case LayerId::Tone:
        return {60.f, 800.f, 120.f, 0.35f};
      case LayerId::Noise:
        return {200.f, 6000.f, 1200.f, 0.4f};
      case LayerId::PercNoise:
        return {2000.f, 14000.f, 6000.f, 0.4f};
      default:
        return {20.f, 20000.f, 1000.f, 0.5f};
    }
  }

  OscillatorRecipe oscillator(LayerId layer) const override {
    OscillatorRecipe r;
    switch (layer) {
      case LayerId::Foundation:
        r.kind = OscillatorRecipe::Kind::MonoSineDynamic;
        r.max_partials = 1;
        break;
      case LayerId::Tone:
        r.kind = OscillatorRecipe::Kind::PolySineStatic;
        r.max_partials = 6;
        break;
      case LayerId::PercNoise:
        r.kind = OscillatorRecipe::Kind::PolyNoiseShort;
        r.noise_q = 1.2f;
        break;
      case LayerId::Noise:
      case LayerId::Transient:
        r.kind = OscillatorRecipe::Kind::PolyNoiseStatic;
        r.noise_q = 2.0f;
        break;
      default:
        break;
    }
    return r;
  }

  ModelParams default_params() const override {
    ModelParams p;
    p.reset_defaults();
    p.foundation_gain = 1.0f;
    p.tone_gain = 0.35f;
    p.noise_gain = 0.15f;
    p.transient_gain = 1.15f;
    p.perc_noise_gain = 0.4f;
    p.stereo_width = 0.05f;
    p.attack_tighten = 1.1f;
    p.body_decay = 1.0f;
    return p;
  }

  float pitch_min_hz() const override { return 28.f; }
  float pitch_max_hz() const override { return 240.f; }
};

}  // namespace

std::unique_ptr<IModel> make_kick_ada() { return std::make_unique<KickAda>(); }

}  // namespace nodruma
