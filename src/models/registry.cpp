#include "nodruma/model.hpp"

#include <memory>
#include <string>

namespace nodruma {

std::unique_ptr<IModel> make_kick_ada();
std::unique_ptr<IModel> make_snare_v1();
std::unique_ptr<IModel> make_hat_v1();

std::unique_ptr<IModel> create_model(std::string_view id) {
  if (id == "kick" || id == "kick_ada" || id == "kick/ada.1") return make_kick_ada();
  if (id == "snare" || id == "snare_v1" || id == "snare/v1") return make_snare_v1();
  if (id == "hat" || id == "hat_v1" || id == "hat/v1") return make_hat_v1();
  return nullptr;
}

std::vector<std::string> list_models() {
  return {"kick", "snare", "hat"};
}

}  // namespace nodruma
