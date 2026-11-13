//! Native OS window for QodeX Desktop.
//! It is not a browser tab. It only talks to the loopback shell.

mod api;

use std::io::Read;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use eframe::egui;

use api::{act_body, parse_live, parse_shell_url, Live, ShellUrl};

enum Cmd { Poll, Act(String), Shot }
enum Ev { Live(Live), Shot(Vec<u8>), Err(String) }

struct Worker { tx: Sender<Cmd>, rx: Receiver<Ev>, busy: bool }

impl Worker {
    fn start(shell: ShellUrl) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();
        let (ev_tx, ev_rx) = mpsc::channel::<Ev>();
        thread::spawn(move || worker(shell, cmd_rx, ev_tx));
        Self { tx: cmd_tx, rx: ev_rx, busy: false }
    }

    fn send(&mut self, cmd: Cmd) {
        if self.tx.send(cmd).is_ok() { self.busy = true; }
    }
}

fn worker(shell: ShellUrl, cmds: Receiver<Cmd>, ev: Sender<Ev>) {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).redirects(0).build();
    let live_url = format!("{}/live?k={}", shell.origin, shell.token);
    let act_url = format!("{}/act?k={}", shell.origin, shell.token);
    let shot_url = format!("{}/shot?k={}", shell.origin, shell.token);
    while let Ok(cmd) = cmds.recv() {
        let result = match cmd {
            Cmd::Poll => fetch_live(&agent, &live_url),
            Cmd::Act(body) => match agent.post(&act_url)
                .set("content-type", "application/x-www-form-urlencoded")
                .send_string(&body) {
                Ok(_) => fetch_live(&agent, &live_url),
                Err(ureq::Error::Status(code, _)) if (300..400).contains(&code) => fetch_live(&agent, &live_url),
                Err(err) => Ev::Err(err.to_string()),
            },
            Cmd::Shot => match agent.get(&shot_url).call() {
                Ok(resp) => {
                    let mut bytes = Vec::new();
                    match resp.into_reader().read_to_end(&mut bytes) {
                        Ok(_) => Ev::Shot(bytes),
                        Err(err) => Ev::Err(err.to_string()),
                    }
                }
                Err(err) => Ev::Err(err.to_string()),
            },
        };
        if ev.send(result).is_err() { break; }
    }
}

fn fetch_live(agent: &ureq::Agent, url: &str) -> Ev {
    match agent.get(url).call() {
        Ok(resp) => match resp.into_string() {
            Ok(text) => match parse_live(&text) {
                Ok(live) => Ev::Live(live),
                Err(err) => Ev::Err(err),
            },
            Err(err) => Ev::Err(err.to_string()),
        },
        Err(err) => Ev::Err(err.to_string()),
    }
}

struct App {
    worker: Worker,
    live: Live,
    status: String,
    top: bool,
    goal: String,
    typed: String,
    click_x: String,
    click_y: String,
    keys: String,
    combo: String,
    focus_app: String,
    shot: Option<egui::TextureHandle>,
    shot_at: Option<Instant>,
    last_poll: Instant,
}

impl App {
    fn new(shell: ShellUrl) -> Self {
        let mut worker = Worker::start(shell);
        worker.send(Cmd::Poll);
        Self {
            worker,
            live: Live::default(),
            status: "Connecting to this machine…".into(),
            top: false,
            goal: String::new(),
            typed: String::new(),
            click_x: String::new(),
            click_y: String::new(),
            keys: String::new(),
            combo: String::new(),
            focus_app: String::new(),
            shot: None,
            shot_at: None,
            last_poll: Instant::now(),
        }
    }

    fn act(&mut self, fields: &[(&str, &str)]) {
        self.worker.send(Cmd::Act(act_body(fields)));
    }

    fn toggle_top(&mut self, ctx: &egui::Context) {
        self.top = !self.top;
        let level = if self.top { egui::WindowLevel::AlwaysOnTop } else { egui::WindowLevel::Normal };
        ctx.send_viewport_cmd(egui::ViewportCommand::WindowLevel(level));
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        while let Ok(ev) = self.worker.rx.try_recv() {
            self.worker.busy = false;
            match ev {
                Ev::Live(live) => {
                    let want_shot = live.shot;
                    self.live = live;
                    self.status.clear();
                    if want_shot && self.shot_at.map(|t| t.elapsed() > Duration::from_secs(2)).unwrap_or(true) {
                        self.shot_at = Some(Instant::now());
                        self.worker.send(Cmd::Shot);
                    }
                }
                Ev::Shot(bytes) => {
                    if let Ok(img) = image::load_from_memory(&bytes) {
                        let rgba = img.to_rgba8();
                        let color = egui::ColorImage::from_rgba_unmultiplied(
                            [rgba.width() as usize, rgba.height() as usize],
                            rgba.as_raw(),
                        );
                        self.shot = Some(ctx.load_texture("screen", color, egui::TextureOptions::LINEAR));
                    } else {
                        self.status = "Screenshot was not a PNG.".into();
                    }
                }
                Ev::Err(err) => self.status = err,
            }
        }
        if self.last_poll.elapsed() > Duration::from_secs(2) && !self.worker.busy {
            self.last_poll = Instant::now();
            self.worker.send(Cmd::Poll);
        }
        ctx.request_repaint_after(Duration::from_millis(400));

        egui::TopBottomPanel::top("bar").show(ctx, |ui| {
            egui::menu::bar(ui, |ui| {
                ui.label(egui::RichText::new("QodeX").strong());
                ui.label("Desktop");
                ui.separator();
                if ui.button("Read tree").clicked() { self.act(&[("action", "tree")]); }
                if ui.button("Screenshot").clicked() {
                    self.shot_at = None;
                    self.act(&[("action", "shot")]);
                }
                let top = if self.top { "Always on top: on" } else { "Always on top: off" };
                if ui.button(top).clicked() { self.toggle_top(ctx); }
                ui.separator();
                ui.label(self.live.resident.as_str());
                ui.label(format!("{} waiting", self.live.pending));
                if ui.button("Quit").clicked() { ctx.send_viewport_cmd(egui::ViewportCommand::Close); }
            });
        });

        if !self.status.is_empty() {
            egui::TopBottomPanel::bottom("status").show(ctx, |ui| {
                ui.colored_label(egui::Color32::from_rgb(255, 160, 120), &self.status);
            });
        }

        egui::SidePanel::left("desks").exact_width(300.0).show(ctx, |ui| {
            ui.heading("Desks");
            if self.live.desks.is_empty() { ui.label("No desks on this machine."); }
            for desk in self.live.desks.clone() {
                ui.separator();
                ui.label(egui::RichText::new(&desk.name).strong());
                for goal in &desk.goals {
                    ui.horizontal(|ui| {
                        ui.label(&goal.status);
                        ui.label(&goal.text);
                    });
                    if goal.status == "needs-approval" {
                        ui.horizontal(|ui| {
                            if ui.button("Allow goal").clicked() {
                                self.act(&[("action", "approve"), ("deskId", &desk.id), ("goalId", &goal.id), ("allow", "yes")]);
                            }
                            if ui.button("Deny goal").clicked() {
                                self.act(&[("action", "approve"), ("deskId", &desk.id), ("goalId", &goal.id), ("allow", "no")]);
                            }
                        });
                    }
                }
                ui.horizontal(|ui| {
                    ui.add(egui::TextEdit::singleline(&mut self.goal).hint_text("Assign a goal").desired_width(150.0));
                    if ui.button("Assign").clicked() && !self.goal.trim().is_empty() {
                        let text = self.goal.trim().to_string();
                        self.act(&[("action", "goal"), ("deskId", &desk.id), ("text", &text)]);
                        self.goal.clear();
                    }
                });
                if desk.runnable && ui.button("Run next").clicked() {
                    self.act(&[("action", "run"), ("deskId", &desk.id)]);
                }
            }
            ui.add_space(12.0);
            ui.heading("Waiting");
            if self.live.waits.is_empty() { ui.label("Nothing is waiting."); }
            for wait in self.live.waits.clone() {
                ui.separator();
                ui.label(format!("{}  {}", wait.kind, wait.id));
                ui.label(&wait.reason);
                if !wait.prompt.is_empty() { ui.label(&wait.prompt); }
                ui.horizontal(|ui| {
                    if ui.button("Allow").clicked() { self.act(&[("action", "allow"), ("id", &wait.id)]); }
                    if ui.button("Deny").clicked() { self.act(&[("action", "deny"), ("id", &wait.id)]); }
                });
            }
        });

        egui::SidePanel::right("screen").exact_width(340.0).show(ctx, |ui| {
            ui.heading("Screen");
            if !self.live.result.is_empty() { ui.label(&self.live.result); }
            if let Some(tex) = &self.shot {
                ui.image((tex.id(), ui.available_width() * egui::vec2(1.0, tex.aspect_ratio().recip())));
            } else {
                ui.label("No screenshot yet. This machine, not a remote browser.");
            }
            ui.add_space(8.0);
            ui.heading("Audit");
            for row in self.live.audit.iter().rev().take(6) {
                ui.label(format!("{}  {}  {}", row.ts, row.kind, row.detail));
            }
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("This machine");
            ui.label("You are here, so these run now. The model still has to ask.");
            ui.horizontal(|ui| {
                ui.add(egui::TextEdit::singleline(&mut self.click_x).hint_text("x").desired_width(56.0));
                ui.add(egui::TextEdit::singleline(&mut self.click_y).hint_text("y").desired_width(56.0));
                if ui.button("Click").clicked() {
                    let x = self.click_x.trim().to_string();
                    let y = self.click_y.trim().to_string();
                    self.act(&[("action", "operate"), ("kind", "click"), ("x", &x), ("y", &y)]);
                }
                if ui.button("Windows").clicked() { self.act(&[("action", "operate"), ("kind", "windows")]); }
                if ui.button("Front").clicked() { self.act(&[("action", "operate"), ("kind", "front")]); }
            });
            ui.horizontal(|ui| {
                ui.add(egui::TextEdit::singleline(&mut self.keys).hint_text("Keys into the focused app").desired_width(220.0));
                if ui.button("Keys").clicked() && !self.keys.is_empty() {
                    let text = self.keys.clone();
                    self.act(&[("action", "operate"), ("kind", "keystroke"), ("text", &text)]);
                    self.keys.clear();
                }
            });
            ui.horizontal(|ui| {
                ui.add(egui::TextEdit::singleline(&mut self.combo).hint_text("ctrl+l").desired_width(120.0));
                if ui.button("Combo").clicked() && !self.combo.trim().is_empty() {
                    let combo = self.combo.trim().to_string();
                    self.act(&[("action", "operate"), ("kind", "key"), ("combo", &combo)]);
                }
                ui.add(egui::TextEdit::singleline(&mut self.focus_app).hint_text("App or window").desired_width(140.0));
                if ui.button("Focus").clicked() && !self.focus_app.trim().is_empty() {
                    let app = self.focus_app.trim().to_string();
                    self.act(&[("action", "operate"), ("kind", "focus"), ("app", &app)]);
                }
            });
            ui.separator();
            ui.heading(format!("Controls  {}", self.live.controls.len()));
            egui::ScrollArea::vertical().show(ui, |ui| {
                if self.live.controls.is_empty() {
                    ui.label("Read the tree. Rows appear only for names the accessibility backend returned.");
                }
                for control in self.live.controls.clone() {
                    ui.separator();
                    ui.horizontal(|ui| {
                        ui.label(&control.role);
                        ui.label(egui::RichText::new(&control.name).strong());
                        if !control.enabled { ui.label("disabled"); }
                    });
                    ui.label(format!("{}   {}", control.app, control.value));
                    ui.horizontal(|ui| {
                        if ui.button("Press").clicked() {
                            self.act(&[("action", "invoke"), ("name", &control.name), ("role", &control.role), ("app", &control.app)]);
                        }
                        ui.add(egui::TextEdit::singleline(&mut self.typed).hint_text("One line").desired_width(160.0));
                        if ui.button("Type").clicked() && !self.typed.is_empty() {
                            let text = self.typed.clone();
                            self.act(&[("action", "type"), ("name", &control.name), ("role", &control.role), ("app", &control.app), ("text", &text)]);
                            self.typed.clear();
                        }
                    });
                }
            });
        });
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--self-test") {
        println!("qodex-desktop ok");
        return;
    }
    let url = args.windows(2).find(|pair| pair[0] == "--url").map(|pair| pair[1].as_str());
    let Some(url) = url else {
        eprintln!("usage: qodex-desktop --url http://127.0.0.1:<port>/?k=<token>");
        std::process::exit(2);
    };
    let shell = match parse_shell_url(url) {
        Ok(shell) => shell,
        Err(err) => { eprintln!("{err}"); std::process::exit(2); }
    };
    let native = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("QodeX Desktop")
            .with_inner_size([1180.0, 760.0])
            .with_min_inner_size([860.0, 560.0]),
        ..Default::default()
    };
    if let Err(err) = eframe::run_native(
        "QodeX Desktop",
        native,
        Box::new(move |_cc| Ok(Box::new(App::new(shell)))),
    ) {
        eprintln!("native window failed: {err}");
        std::process::exit(1);
    }
}
