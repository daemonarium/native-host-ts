cmake_minimum_required(VERSION 3.17)
project(nativeHost CXX C)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT TARGET cpp_rpc)
  include(FetchContent)
  FetchContent_Declare(cpp_rpc
    GIT_REPOSITORY https://github.com/daemonarium/rpc-cpp.git
    GIT_TAG v0.2.0
    GIT_SHALLOW TRUE
  )
  FetchContent_MakeAvailable(cpp_rpc)
endif()
set(RPC_CPP_DIR ${cpp_rpc_SOURCE_DIR})

# node-addon-api lives next to this package, or hoisted at the stack workspace root.
set(_addon_search "${CMAKE_CURRENT_SOURCE_DIR}")
set(NODE_ADDON_API_DIR "")
foreach(_i RANGE 6)
  if(EXISTS "${_addon_search}/node_modules/node-addon-api/napi.h")
    set(NODE_ADDON_API_DIR "${_addon_search}/node_modules/node-addon-api")
    break()
  endif()
  get_filename_component(_addon_search "${_addon_search}" DIRECTORY)
endforeach()
if(NODE_ADDON_API_DIR STREQUAL "")
  message(FATAL_ERROR "node-addon-api not found. Run npm install in the stack workspace.")
endif()

# cmake-js provides CMAKE_JS_INC / CMAKE_JS_SRC when invoked via cmake-js
if(NOT DEFINED CMAKE_JS_INC)
  message(FATAL_ERROR "Build with cmake-js (npm install / cmake-js compile)")
endif()

add_library(${PROJECT_NAME} SHARED
  src/native_process_addon.cpp
  src/service_registry.cpp
  src/echo_service.cpp
  ${RPC_CPP_DIR}/src/native/native_process.cpp
  ${RPC_CPP_DIR}/src/io/circular_buffer.c
  ${CMAKE_JS_SRC}
)

set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  OUTPUT_NAME "nativeHost"
)

target_include_directories(${PROJECT_NAME} PRIVATE
  ${RPC_CPP_DIR}/src
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${CMAKE_JS_INC}
  ${NODE_ADDON_API_DIR}
)

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_VERSION=8
  NODE_ADDON_API_DISABLE_DEPRECATED
)

# Do not link libnode on Linux; cmake-js MODULE linking is sufficient
if(WIN32)
  target_link_libraries(${PROJECT_NAME} PRIVATE ${CMAKE_JS_LIB})
endif()
