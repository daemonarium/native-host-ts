#pragma once

#include "native_service.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace waos::native_host {

  using service_factory_fn = std::function<
    std::unique_ptr<native_service>(
        std::uint32_t id,
        std::uint32_t socket_count,
        const service_create_opts& opts)
  >;

  class service_registry {
    public:
      void register_service(const std::string& name, service_factory_fn factory);

      std::unique_ptr<native_service> create(
          const std::string& name,
          std::uint32_t id,
          std::uint32_t socket_count,
          const service_create_opts& opts);

      std::vector<std::string> list_services() const;

      bool has_service(const std::string& name) const;

    private:
      std::unordered_map<std::string, service_factory_fn> factories_;
  };

  service_registry& registry();

}
