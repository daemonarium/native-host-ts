#include "service_registry.hpp"

#include <stdexcept>

namespace waos::native_host {

  service_registry& registry() {
    static service_registry instance;
    return instance;
  }

  void service_registry::register_service(
      const std::string& name,
      service_factory_fn factory) {
    factories_[name] = std::move(factory);
  }

  std::unique_ptr<native_service> service_registry::create(
      const std::string& name,
      std::uint32_t id,
      std::uint32_t socket_count,
      const service_create_opts& opts) {
    auto it = factories_.find(name);
    if(it == factories_.end()) {
      throw std::runtime_error("native-host: unknown service type: " + name);
    }
    return it->second(id, socket_count, opts);
  }

  std::vector<std::string> service_registry::list_services() const {
    std::vector<std::string> names;
    names.reserve(factories_.size());
    for(const auto& [name, _] : factories_) {
      names.push_back(name);
    }
    return names;
  }

  bool service_registry::has_service(const std::string& name) const {
    return factories_.find(name) != factories_.end();
  }

}
