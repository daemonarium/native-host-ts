#pragma once

#include <cstdint>
#include <cstddef>
#include <functional>
#include <optional>
#include <string>

#include <native/native_process.hpp>

namespace waos::native_host {

  struct service_create_opts {
    std::string data_dir;
    std::size_t buf_size = 65536;
  };

  class native_service {
    public:
      virtual ~native_service() = default;
      virtual waos::native::native_process& process() = 0;
      virtual void on_socket_opened(std::uint32_t socket) { (void)socket; }
      virtual void set_io_wake(std::function<void()> cb) { (void)cb; }
      virtual void kill() { process().kill(std::nullopt); }
  };

}
