#include "test_assert.hpp"

#include "nodruma/model.hpp"

void test_models() {
  auto models = nodruma::list_models();
  CHECK(models.size() == 3);
  for (const auto& id : models) {
    auto m = nodruma::create_model(id);
    CHECK(m != nullptr);
    CHECK(!m->name().empty());
    auto prior = m->band_prior(nodruma::LayerId::Foundation);
    CHECK(prior.high_hz > prior.low_hz);
  }
  CHECK(nodruma::create_model("nope") == nullptr);
}
