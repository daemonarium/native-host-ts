#include "service_registry.hpp"

#include <stdexcept>

namespace waos::native_host {

  service_registry& registry() {
    static service_registry instance;
    return instance;
  }

  void service_registry::register_service(
      const std::string& name,
      service_factory_fn factory,
      socket_opened_fn on_socket_opened) {
    factories_[name] = service_entry{
      std::move(factory),
      std::move(on_socket_opened),
    };
  }

  std::unique_ptr<waos::native::native_process> service_registry::create(
      const std::string& name,
      std::uint32_t id,
      std::uint32_t socket_count) {
    auto it = factories_.find(name);
    if(it == factories_.end()) {
      throw std::runtime_error("native-host: unknown service type: " + name);
    }
    return it->second.factory(id, socket_count);
  }

  socket_opened_fn service_registry::on_socket_opened(const std::string& name) const {
    auto it = factories_.find(name);
    if(it == factories_.end()) {
      return {};
    }
    return it->second.on_socket_opened;
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
