#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <native/native_process.hpp>

namespace waos::native_host {

  using service_factory_fn = std::function<
    std::unique_ptr<waos::native::native_process>(std::uint32_t id, std::uint32_t socket_count)
  >;

  using socket_opened_fn = std::function<
    void(waos::native::native_process& proc, std::uint32_t socket)
  >;

  struct service_entry {
    service_factory_fn factory;
    socket_opened_fn on_socket_opened;
  };

  class service_registry {
    public:
      void register_service(
          const std::string& name,
          service_factory_fn factory,
          socket_opened_fn on_socket_opened = {});

      std::unique_ptr<waos::native::native_process> create(
          const std::string& name,
          std::uint32_t id,
          std::uint32_t socket_count);

      socket_opened_fn on_socket_opened(const std::string& name) const;

      std::vector<std::string> list_services() const;

      bool has_service(const std::string& name) const;

    private:
      std::unordered_map<std::string, service_entry> factories_;
  };

  service_registry& registry();

}
