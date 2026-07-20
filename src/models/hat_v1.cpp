#include "nodruma/model.hpp"

namespace nodruma {

namespace {

class HatV1 final : public IModel {
public:
  std::string_view id() const override { return "hat"; }
  std::string_view name() const override { return "hat/v1"; }
  std::string_view description() const override {
    return "Hi-hat model: short noise-dominant burst, minimal foundation";
  }

  BandPrior band_prior(LayerId layer) const override {
    switch (layer) {
      case LayerId::Transient:
        return {4000.f, 18000.f, 9000.f, 0.3f};
      case LayerId::Foundation:
        return {200.f, 800.f, 400.f, 0.4f};
      case LayerId::Tone:
        return {1000.f, 8000.f, 3000.f, 0.4f};
      case LayerId::Noise:
        return {3000.f, 18000.f, 8000.f, 0.35f};
      case LayerId::PercNoise:
        return {6000.f, 20000.f, 12000.f, 0.3f};
      default:
        return {1000.f, 20000.f, 8000.f, 0.5f};
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
        r.max_partials = 4;
        break;
      default:
        r.kind = OscillatorRecipe::Kind::PolyNoiseShort;
        r.noise_q = 0.8f;
        break;
    }
    return r;
  }

  ModelParams default_params() const override {
    ModelParams p;
    p.reset_defaults();
    p.foundation_gain = 0.15f;
    p.tone_gain = 0.25f;
    p.noise_gain = 1.0f;
    p.transient_gain = 1.0f;
    p.perc_noise_gain = 0.9f;
    p.attack_tighten = 0.7f;
    p.body_decay = 0.5f;
    p.stereo_width = 0.25f;
    return p;
  }

  float pitch_min_hz() const override { return 200.f; }
  float pitch_max_hz() const override { return 2000.f; }
};

}  // namespace

std::unique_ptr<IModel> make_hat_v1() { return std::make_unique<HatV1>(); }

}  // namespace nodruma
