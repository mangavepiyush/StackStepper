#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <new>

namespace {
struct VizStreamFlusher {
  VizStreamFlusher() {
    std::ios_base::sync_with_stdio(true);
    std::cout << std::unitbuf;
    std::cerr << std::unitbuf;
    std::clog << std::unitbuf;
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    std::setvbuf(stderr, nullptr, _IONBF, 0);
  }
};

VizStreamFlusher __viz_stream_flusher;
}

extern "C" {
struct VizAllocationRecord {
  void* address;
  size_t size;
  unsigned long long id;
  int active;
  int isArray;
};

VizAllocationRecord __viz_allocations[4096];
unsigned long long __viz_allocation_count = 0;
unsigned long long __viz_next_allocation_id = 1;
}

static void viz_record_allocation(void* address, size_t size, int isArray) {
  if (!address || __viz_allocation_count >= 4096) {
    return;
  }

  VizAllocationRecord& record = __viz_allocations[__viz_allocation_count++];
  record.address = address;
  record.size = size;
  record.id = __viz_next_allocation_id++;
  record.active = 1;
  record.isArray = isArray;
}

static void viz_record_free(void* address) {
  if (!address) {
    return;
  }

  for (long long index = static_cast<long long>(__viz_allocation_count) - 1; index >= 0; --index) {
    if (__viz_allocations[index].address == address && __viz_allocations[index].active) {
      __viz_allocations[index].active = 0;
      return;
    }
  }
}

void* operator new(size_t size) {
  if (void* memory = std::malloc(size)) {
    viz_record_allocation(memory, size, 0);
    return memory;
  }
  throw std::bad_alloc();
}

void* operator new[](size_t size) {
  if (void* memory = std::malloc(size)) {
    viz_record_allocation(memory, size, 1);
    return memory;
  }
  throw std::bad_alloc();
}

void operator delete(void* memory) noexcept {
  viz_record_free(memory);
  std::free(memory);
}

void operator delete[](void* memory) noexcept {
  viz_record_free(memory);
  std::free(memory);
}

void operator delete(void* memory, size_t) noexcept {
  viz_record_free(memory);
  std::free(memory);
}

void operator delete[](void* memory, size_t) noexcept {
  viz_record_free(memory);
  std::free(memory);
}

void* operator new(size_t size, const std::nothrow_t&) noexcept {
  void* memory = std::malloc(size);
  viz_record_allocation(memory, size, 0);
  return memory;
}

void* operator new[](size_t size, const std::nothrow_t&) noexcept {
  void* memory = std::malloc(size);
  viz_record_allocation(memory, size, 1);
  return memory;
}

void operator delete(void* memory, const std::nothrow_t&) noexcept {
  viz_record_free(memory);
  std::free(memory);
}

void operator delete[](void* memory, const std::nothrow_t&) noexcept {
  viz_record_free(memory);
  std::free(memory);
}
