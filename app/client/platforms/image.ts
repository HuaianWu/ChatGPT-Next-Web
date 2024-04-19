"use client";
import {
  ApiPath,
  DEFAULT_API_HOST,
  DEFAULT_MODELS,
  OpenaiPath,
  VideoPath,
  ImagePath,
  REQUEST_TIMEOUT_MS,
  ServiceProvider,
} from "@/app/constant";
import {useAccessStore, useAppConfig, useChatStore} from "@/app/store";

import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  LLMUsage,
  MultimodalContent,
} from "../api";
import Locale from "../../locales";
import {
  EventStreamContentType,
  fetchEventSource,
} from "@fortaine/fetch-event-source";
import {prettyObject} from "@/app/utils/format";
import {getClientConfig} from "@/app/config/client";
import {makeAzurePath} from "@/app/azure";
import {
  getMessageTextContent,
  getMessageImages,
  isVisionModel,
} from "@/app/utils";
import de from "../../locales/de";

import {
  showToast,
} from "./../../components/ui-lib";

export interface OpenAIListModelResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    root: string;
  }>;
}

export class ImageApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    const isAzure = accessStore.provider === ServiceProvider.Azure;

    if (isAzure && !accessStore.isValidAzure()) {
      throw Error(
          "incomplete azure config, please check it in your settings page",
      );
    }

    let baseUrl = accessStore.excelUrl;

    // if (baseUrl.length === 0) {
    //   const isApp = !!getClientConfig()?.isApp;
    //   baseUrl = isApp
    //     ? DEFAULT_API_HOST + "/proxy" + ApiPath.OpenAI
    //     : ApiPath.OpenAI;
    // }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    // if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.OpenAI)) {
    //   baseUrl = "https://" + baseUrl;
    // }
    //
    // if (isAzure) {
    //   path = makeAzurePath(path, accessStore.azureApiVersion);
    // }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    return [baseUrl, path].join("/");
  }

  extractMessage(res: any) {
    return res.choices?.at(0)?.message?.content ?? "";
  }

  async video(options: ChatOptions) {

    let loopTimeOutId: any = null;

    /**
     * 循环获取视频
     */
    const loopGetVideo = async (videoId: any) => {
      try {
        const res = await fetch(this.path(`${VideoPath.VideoPath}/${videoId}`), {
          method: "GET",
          headers: {
            ...getHeaders(),
          },
        });
        const resJson = (await res.json()) as any;
        if (resJson.status == 'success') {
          const extraInfo = [{
            type: "video_url",
            video_url: {
              url: resJson.video_url,
            },
          }];
          clearTimeout(loopTimeOutId);
          options.onRefreshVideo('');
          options.onFinish(extraInfo);

        } else {
          loopTimeOutId = setTimeout(() => {
            loopGetVideo(videoId);
          }, 10000)
        }

      } catch (e) {
        console.log(e)
      }
    }


    if (options.session.videoId) {
      showToast('请等待视频生成');
      loopGetVideo(options.session.videoId);
    } else {
      showToast('请求失败');
      options.onFinish('');
      // options.onFinish(resJson?.message || '请求失败，请稍后重试');
    }

  }

  async chat(options: ChatOptions) {
    const visionModel = isVisionModel(options.config.model);
    const messages = options.messages.map((v) => ({
      role: v.role,
      content: visionModel ? v.content : getMessageTextContent(v),
    }));

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
      },
    };

    const requestPayload = {
      // messages,
      ask: messages[messages.length - 1].content,
      // stream: options.config.stream,
      // model: modelConfig.model,
      // temperature: modelConfig.temperature,
      // presence_penalty: modelConfig.presence_penalty,
      // frequency_penalty: modelConfig.frequency_penalty,
      // top_p: modelConfig.top_p,
      // max_tokens: Math.max(modelConfig.max_tokens, 1024),
      // Please do not ask me why not send max_tokens, no reason, this param is just shit, I dont want to explain anymore.
    };

    console.log("[Request] video payload: ", requestPayload);

    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const chatPath = this.path(ImagePath.ChatPath);
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS,
      );

      let loopTimeOutId: any = null;


      /**
       * 循环获取视频
       */
      const loopGetVideo = async (videoId: any) => {
        try {
          const res = await fetch(this.path(`${VideoPath.VideoPath}/${videoId}`), {
            method: "GET",
            headers: {
              ...getHeaders(),
            },
          });
          const resJson = (await res.json()) as any;
          if (resJson.status == 'success') {
            const extraInfo = [{
              type: "video_url",
              video_url: {
                url: resJson.video_url,
              },
            }];
            clearTimeout(loopTimeOutId);
            options.onRefreshVideo('');
            options.onFinish(extraInfo);

          } else {
            loopTimeOutId = setTimeout(() => {
              loopGetVideo(videoId);
            }, 10000)
          }

        } catch (e) {
          console.log(e)
        }
      }

      if (shouldStream) {
        let responseText = "";
        let remainText = "";
        let finished = false;

        // animate response to make it looks smooth
        function animateResponseText() {
          if (finished || controller.signal.aborted) {
            responseText += remainText;
            console.log("[Response Animation] finished");
            return;
          }

          if (remainText.length > 0) {
            const fetchCount = Math.max(1, Math.round(remainText.length / 60));
            const fetchText = remainText.slice(0, fetchCount);
            responseText += fetchText;
            remainText = remainText.slice(fetchCount);
            options.onUpdate?.(responseText, fetchText);
          }

          requestAnimationFrame(animateResponseText);
        }

        // start animaion
        animateResponseText();

        const finish = () => {
          if (!finished) {
            finished = true;
            options.onFinish(responseText + remainText);
          }
        };

        controller.signal.onabort = finish;

        fetchEventSource(chatPath, {
          ...chatPayload,
          async onopen(res) {
            clearTimeout(requestTimeoutId);
            const contentType = res.headers.get("content-type");
            console.log(
                "[OpenAI] request response content type: ",
                contentType,
            );

            if (contentType?.startsWith("text/plain")) {
              responseText = await res.clone().text();
              return finish();
            }

            if (
                !res.ok ||
                !res.headers
                    .get("content-type")
                    ?.startsWith(EventStreamContentType) ||
                res.status !== 200
            ) {
              const responseTexts = [responseText];
              let extraInfo = await res.clone().text();
              try {
                const resJson = await res.clone().json();
                extraInfo = prettyObject(resJson);
              } catch {
              }

              if (res.status === 401) {
                responseTexts.push(Locale.Error.Unauthorized);
              }

              if (extraInfo) {
                responseTexts.push(extraInfo);
              }

              responseText = responseTexts.join("\n\n");

              return finish();
            }
          },
          onmessage(msg) {
            if (msg.data === "[DONE]" || finished) {
              return finish();
            }
            const text = msg.data;
            try {
              const json = JSON.parse(text) as {
                choices: Array<{
                  delta: {
                    content: string;
                  };
                }>;
              };
              const delta = json.choices[0]?.delta?.content;
              if (delta) {
                remainText += delta;
              }
            } catch (e) {
              console.error("[Request] parse error", text);
            }
          },
          onclose() {
            finish();
          },
          onerror(e) {
            options.onError?.(e);
            throw e;
          },
          openWhenHidden: true,
        });
      } else {
        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();

        if (resJson.status == 'success' && resJson.data) {
          showToast('请求成功！请等待~');
          // setTimeout(() => {
          if (resJson.data.indexOf('http') > -1) {
            options.onFinish([{
              type: "image_url",
              image_url: {
                url: resJson.data,
              },
            }]);
          } else {
            options.onFinish(resJson.data);
          }


          // }, 5000)
        } else {
          showToast(resJson?.message || '请求失败，请稍后重试');
          // options.onFinish('');
          options.onFinish(resJson?.message || '请求失败，请稍后重试');
        }
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }

  async usage() {
    const formatDate = (d: Date) =>
        `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
            .getDate()
            .toString()
            .padStart(2, "0")}`;
    const ONE_DAY = 1 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startDate = formatDate(startOfMonth);
    const endDate = formatDate(new Date(Date.now() + ONE_DAY));

    const [used, subs] = await Promise.all([
      fetch(
          this.path(
              `${OpenaiPath.UsagePath}?start_date=${startDate}&end_date=${endDate}`,
          ),
          {
            method: "GET",
            headers: getHeaders(),
          },
      ),
      fetch(this.path(OpenaiPath.SubsPath), {
        method: "GET",
        headers: getHeaders(),
      }),
    ]);

    if (used.status === 401) {
      throw new Error(Locale.Error.Unauthorized);
    }

    if (!used.ok || !subs.ok) {
      throw new Error("Failed to query usage from openai");
    }

    const response = (await used.json()) as {
      total_usage?: number;
      error?: {
        type: string;
        message: string;
      };
    };

    const total = (await subs.json()) as {
      hard_limit_usd?: number;
    };

    if (response.error && response.error.type) {
      throw Error(response.error.message);
    }

    if (response.total_usage) {
      response.total_usage = Math.round(response.total_usage) / 100;
    }

    if (total.hard_limit_usd) {
      total.hard_limit_usd = Math.round(total.hard_limit_usd * 100) / 100;
    }

    return {
      used: response.total_usage,
      total: total.hard_limit_usd,
    } as LLMUsage;
  }

  async models(): Promise<LLMModel[]> {
    if (this.disableListModels) {
      return DEFAULT_MODELS.slice();
    }

    const res = await fetch(this.path(OpenaiPath.ListModelPath), {
      method: "GET",
      headers: {
        ...getHeaders(),
      },
    });

    const resJson = (await res.json()) as OpenAIListModelResponse;
    const chatModels = resJson.data?.filter((m) => m.id.startsWith("gpt-"));
    console.log("[Models]", chatModels);

    if (!chatModels) {
      return [];
    }

    return chatModels.map((m) => ({
      name: m.id,
      available: true,
      provider: {
        id: "openai",
        providerName: "OpenAI",
        providerType: "openai",
      },
    }));
  }
}

export {ImagePath};