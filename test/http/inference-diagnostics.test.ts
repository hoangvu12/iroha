import { describe, expect, test } from 'bun:test'
import { upstreamFailureDiagnostic } from '../../src/http/inference.ts'

describe('upstream inference failure diagnostics', () => {
  test('extracts bounded structured DashScope metadata and redacts credential-shaped text', () => {
    const diagnostic = upstreamFailureDiagnostic({
      requestId: 'req_local',
      providerId: 'pr_dashscope',
      model: 'qwen3.7-plus',
      keyId: 'uk_public_id',
      attemptNumber: 2,
      endpointHost: 'dashscope-intl.aliyuncs.com',
      status: 400,
      body: JSON.stringify({
        error: {
          code: 'InvalidParameter',
          message: `bad request for Bearer secret-value and sk-1234567890abcdef\n${'x'.repeat(400)}`,
        },
        request_id: 'dashscope-request-id',
        ignored: 'raw bodies are never copied',
      }),
    })

    expect(diagnostic).toMatchObject({
      event: 'upstream_inference_failure',
      requestId: 'req_local',
      providerId: 'pr_dashscope',
      model: 'qwen3.7-plus',
      keyId: 'uk_public_id',
      attemptNumber: 2,
      endpointHost: 'dashscope-intl.aliyuncs.com',
      status: 400,
      upstreamCode: 'InvalidParameter',
      upstreamRequestId: 'dashscope-request-id',
    })
    expect(diagnostic).not.toHaveProperty('upstreamMessage')
    expect(String(diagnostic.upstreamMessage).length).toBeLessThanOrEqual(240)
    expect(JSON.stringify(diagnostic)).not.toContain('ignored')
    expect(JSON.stringify(diagnostic)).not.toContain('secret-value')
    expect(JSON.stringify(diagnostic)).not.toContain('1234567890abcdef')
  })

  test('does not log an unstructured upstream body', () => {
    const diagnostic = upstreamFailureDiagnostic({
      requestId: 'req_local',
      providerId: 'pr_dashscope',
      model: 'qwen3.7-plus',
      keyId: 'uk_public_id',
      attemptNumber: 1,
      endpointHost: 'dashscope-intl.aliyuncs.com',
      status: 400,
      body: 'possibly sensitive free-form upstream text',
    })

    expect(diagnostic.upstreamCode).toBeNull()
    expect(diagnostic).not.toHaveProperty('upstreamMessage')
    expect(JSON.stringify(diagnostic)).not.toContain('possibly sensitive')
  })
})
