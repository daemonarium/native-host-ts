#include "echo_service.hpp"
#include "native_service.hpp"
#include "service_registry.hpp"

#include <cstdint>
#include <memory>

extern "C" {
#include <io/circular_buffer.h>
}

namespace waos::native_host {
  namespace {

    class echo_service final : public native_service {
      public:
        echo_service(std::uint32_t id, std::uint32_t socket_count)
          : proc_(std::make_unique<waos::native::native_process>(id, socket_count)) {}

        waos::native::native_process& process() override { return *proc_; }

        void on_socket_opened(std::uint32_t socket) override {
          auto& proc = *proc_;
          proc.register_socket_handler(socket, [&proc, socket]() {
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
          });
        }

      private:
        std::unique_ptr<waos::native::native_process> proc_;
    };

  }

  void register_echo_service() {
    registry().register_service(
        "echo",
        [](std::uint32_t id, std::uint32_t socket_count, const service_create_opts&) {
          return std::make_unique<echo_service>(id, socket_count);
        });
  }

}
