#include "echo_service.hpp"
#include "service_registry.hpp"

#include <cstdint>

extern "C" {
#include <io/circular_buffer.h>
}

namespace waos::native_host {
  namespace {

    void echo_handler(waos::native::native_process& proc, std::uint32_t socket) {
      auto& in = proc.input_buffer(socket);
      auto& out = proc.output_buffer(socket);
      std::uint8_t tmp[4096];
      for(;;) {
        size_t n = circular_buffer_read(&in, tmp, sizeof(tmp));
        if(n == 0) {
          break;
        }
        size_t written = 0;
        while(written < n) {
          size_t w = circular_buffer_write(&out, tmp + written, n - written);
          if(w == 0) {
            break;
          }
          written += w;
        }
      }
      proc.flush(socket);
    }

    void on_echo_socket_opened(waos::native::native_process& proc, std::uint32_t socket) {
      proc.register_socket_handler(socket, [&proc, socket]() {
        echo_handler(proc, socket);
      });
    }

  }

  void register_echo_service() {
    registry().register_service(
        "echo",
        [](std::uint32_t id, std::uint32_t socket_count) {
          return std::make_unique<waos::native::native_process>(id, socket_count);
        },
        on_echo_socket_opened);
  }

}
