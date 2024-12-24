import { describe, expect, test } from "bun:test";
import { chunkArray } from "./util";

describe("chunkArray", () => {
  test("should split array into chunks of specified size", () => {
    const arr = [1, 2, 3, 4, 5];
    const chunkSize = 2;
    const result = chunkArray(arr, chunkSize);
    expect(result).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("should handle empty array", () => {
    const arr: number[] = [];
    const chunkSize = 2;
    const result = chunkArray(arr, chunkSize);
    expect(result).toEqual([]);
  });

  test("should handle chunk size larger than array length", () => {
    const arr = [1, 2, 3];
    const chunkSize = 5;
    const result = chunkArray(arr, chunkSize);
    expect(result).toEqual([[1, 2, 3]]);
  });

  test("should handle chunk size of 1", () => {
    const arr = [1, 2, 3];
    const chunkSize = 1;
    const result = chunkArray(arr, chunkSize);
    expect(result).toEqual([[1], [2], [3]]);
  });

  test("should handle chunk size equal to array length", () => {
    const arr = [1, 2, 3];
    const chunkSize = 3;
    const result = chunkArray(arr, chunkSize);
    expect(result).toEqual([[1, 2, 3]]);
  });
});
