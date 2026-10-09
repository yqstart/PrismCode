package com.example.app;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 黄金夹具入口：运行时暴露 GET /hello，调试时在 hello() 首行下断点，
 * 变量区应能看到请求参数 name。
 */
@SpringBootApplication
@RestController
public class Application {

    @Value("${app.greeting}")
    private String greeting;

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }

    @GetMapping("/hello")
    public String hello(@RequestParam(defaultValue = "world") String name) {
        String message = greeting + ", " + name;
        return message;
    }
}
