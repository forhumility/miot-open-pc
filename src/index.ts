/**
 * @Author       : Humility
 * @Date         : 2022-12-05 17:35:56
 * @LastEditTime : 2022-12-05 17:47:10
 * @LastEditors  : Humility
 * @FilePath     : \miot-open-pc\src\index.ts
 * @Description  :
 */
import { BlinkerDevice } from "./lib/blinker";
import { ButtonWidget } from "./lib/widget";
import { Miot, VA_TYPE } from "./lib/voice-assistant";
// 子进程
const { execSync } = require("child_process");
// ssh客户端
const { Client } = require("ssh2");
// 网络唤醒
const wol = require("wake_on_lan");

const auth = "7bfcf4354aa1"; // 1,点灯app上获得的密匙
const staticIP = "192.168.1.129"; // 2,电脑局域网固定IP，用于检测电脑开关状态以及利用SSH关机，改为你的设置
const pcUsr = "Administrator"; // 3,电脑ssh用户名
const pcPwd = "123456"; // 4,电脑ssh密码
// const pcMac = "24:4B:FE:8A:7C:B2"; // 5,MAC地址，改成你自己电脑网卡的
const pcMac = "A8:A1:59:01:33:77";

let buttonLock = false; // 锁定开关(状态更新前不能控制)
let switchState = ""; // 电脑状态 on/off
let pingCMD = `ping -n 1 -w 1 ${staticIP}`;
const timeout = 30 * 1000; // 指令超时时间
const countdown = 20; // 关机倒计时
let shutdownCMD = `shutdown -s -f -c 将在${countdown}秒内关闭这个电脑 -t ${countdown}`;

let device = new BlinkerDevice(auth, {
  protocol: "mqtts", // 默认mqtts加密通信，可选配置mqtt\mqtts
  webSocket: true, // 默认开启websocket，会占用81端口，使用false可关闭
});
let miot = device.addVoiceAssistant(new Miot(VA_TYPE.OUTLET));
// 注册组件
let button1: ButtonWidget = device.addWidget(new ButtonWidget("btn-pc1"));

device.ready().then(() => {
  // 电源状态改变
  miot.powerChange.subscribe((message) => {
    console.log("miot.powerChange", message);
    device.log(message);
    switch (message.data.set.pState) {
      case "true":
        message.power("on").update();
        buttonCallback("on");
        break;
      case "false":
        message.power("off").update();
        buttonCallback("off");
        break;
      default:
        break;
    }
  });
  //
  miot.stateQuery.subscribe((message) => {
    console.log("miot.stateQuery", message);
    // 问小爱电脑开了吗，ping一次获得电脑实际状态
    if (canReceiveCommand(pingCMD)) {
      switchState = "on";
    } else {
      switchState = "off";
    }
    message.power(switchState).update();
  });
  // 设备心跳
  device.heartbeat.subscribe((message) => {
    heartbeatCallback(message);
  });
  // 设备其他信息
  device.dataRead.subscribe((message) => {
    console.log("otherData:", message);
  });
  // 开关操作监听
  button1.listen().subscribe((message) => {
    console.log("button1:", message);
    const change = switchState == "on" ? "off" : "on";
    buttonCallback(change);
    device.push("blinker push");
  });
  // 设备开关
  device.builtinSwitch.change.subscribe((message) => {
    console.log("builtinSwitch:", message);
    device.builtinSwitch.setState(switchState).update();
  });
});
function heartbeatCallback(msg) {
  console.log("heartbeatCallback:", msg);
  if (canReceiveCommand(pingCMD)) {
    switchState = "on";
    button1.turn("on").text("已开机").update();
  } else {
    switchState = "off";
    button1.turn("off").text("已关机").update();
  }
}
/**
 * @param {string} state 状态 on/off
 * @return {*}
 * @description: 开关回调
 */
async function buttonCallback(state: string) {
  if (buttonLock == false) {
    device.log("发送开机指令...");
    if (state == "on") {
      if (canReceiveCommand(pingCMD)) {
        switchState = "on";
        device.log("检测到电脑已开,按钮状态已更新.");
        button1.turn(state).text("已开机").update();
        device.builtinSwitch.setState(state).update();
      } else {
        device.log("发送开机指令...");
        buttonLock = true;
        powerUpPC();
        let timer = 0;
        let step = 500; // 间隔500毫秒ping一次
        while (!canReceiveCommand(pingCMD) && timer < timeout) {
          await sleep(step);
          timer += step;
        }
        if (timer >= timeout) {
          device.log("开机超时！");
          button1.turn("off").text("已关机").update();
          device.builtinSwitch.setState("off").update();
        } else {
          button1.turn(state).text("已关机").update();
          device.builtinSwitch.setState("on").update();
        }
        buttonLock = false;
      }
    } else if (state == "off") {
      if (canReceiveCommand(pingCMD)) {
        device.log("发送关键机指令...");
        switchState = "off";
        buttonLock = true;
        shutDownPC();
        let timer = 0;
        let step = 500; // 间隔500毫秒ping一次
        while (canReceiveCommand(pingCMD) && timer < timeout) {
          await sleep(step);
          timer += step;
        }
        if (timer >= timeout) {
          device.log("关机超时！");
          button1.turn("on").text("已开机").update();
          device.builtinSwitch.setState("on").update();
        } else {
          button1.turn(state).text("已关机").update();
          device.builtinSwitch.setState(state).update();
        }
        buttonLock = false;
      } else {
        device.log("检测到电脑已关,按钮状态已更新.");
        switchState = "off";
        button1.text("已关机").update();
        device.builtinSwitch.setState("off").update();
      }
    }
  } else {
    device.log("正在开/关机中...");
  }
}
/**
 * @param {string} cmd 指令
 * @return {boolean}
 * @description: 能否接收指令
 */
function canReceiveCommand(cmd: string): boolean {
  try {
    execSync(cmd);
    return true;
  } catch (error) {
    return false;
  }
}
/**
 * @param {number} milliseconds 毫秒
 * @return {Promise}
 * @description: 休眠一段时间
 */
function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
// 开电脑
function powerUpPC() {
  wol.wake(pcMac, (err) => {
    let msg = err ? "powerUpPC error" : "powerUpPC success";
    console.log(msg);
  });
}
// 关电脑
function shutDownPC() {
  const sshClient = new Client();
  sshClient
    .on("ready", () => {
      sshClient.exec(shutdownCMD, (err, stream) => {
        if (err) {
          console.warn("exec error", err);
          return sshClient.end();
        }
        stream
          .on("close", (code) => {
            console.log("stream close", code);
            sshClient.end();
          })
          .on("data", (data) => {
            console.log("stream data", data.toString());
          });
      });
    })
    .on("error", (err) => {
      console.warn("err", err);
    })
    .connect({
      host: staticIP,
      port: "22",
      username: pcUsr,
      password: pcPwd,
    });
}
