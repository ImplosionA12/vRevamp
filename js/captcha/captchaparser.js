const captcha_parse = (imgarr) => {
  let captcha = "";
  for (let x = 1; x < 44; x++) {
    for (let y = 1; y < 179; y++) {
      const condition1 =
        imgarr[x][y - 1] === 255 &&
        imgarr[x][y] === 0 &&
        imgarr[x][y + 1] === 255;
      const condition2 =
        imgarr[x - 1][y] === 255 &&
        imgarr[x][y] === 0 &&
        imgarr[x + 1][y] === 255;
      const condition3 = imgarr[x][y] !== 255 && imgarr[x][y] !== 0;
      if (condition1 || condition2 || condition3) {
        imgarr[x][y] = 255;
      }
    }
  }
  for (let j = 30; j < 181; j += 30) {
    let matches = [];
    const chars = "123456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
    for (let i = 0; i < chars.length; i++) {
      let match = 0;
      let black = 0;
      const ch = chars.charAt(i);
      const mask = bitmaps[ch];
      for (let x = 0; x < 32; x++) {
        for (let y = 0; y < 30; y++) {
          let y1 = y + j - 30;
          let x1 = x + 12;
          if (imgarr[x1][y1] == mask[x][y] && mask[x][y] == 0) {
            match += 1;
          }
          if (mask[x][y] == 0) {
            black += 1;
          }
        }
      }
      const perc = match / black;
      matches.push([perc, ch]);
    }
    captcha += matches.reduce(
      function (a, b) {
        return a[0] > b[0] ? a : b;
      },
      [0, 0]
    )[1];
  }
  return captcha;
};

const uri_to_img_data = (URI) => {
  return new Promise(function (resolve, reject) {
    if (URI == null) return reject();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    let image = new Image();
    image.addEventListener(
      "load",
      function () {
        canvas.width = image.width;
        canvas.height = image.height;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(context.getImageData(0, 0, canvas.width, canvas.height));
      },
      false
    );
    image.src = URI;
  });
};

const fill_captcha = (imgb64) => {
  const URI = imgb64;
  uri_to_img_data(URI).then((imageData) => {
    let arr = [];
    let newArr = [];
    for (let i = 0; i < imageData["data"].length; i += 4) {
      let gval =
        imageData["data"][i] * 0.299 +
        imageData["data"][i + 1] * 0.587 +
        imageData["data"][i + 2] * 0.114;
      arr.push(gval);
    }
    while (arr.length) newArr.push(arr.splice(0, 180));
    const res = captcha_parse(newArr);
    document.getElementById("captchaCheck").value = res;
  });
};

const solve_captcha = (img) => {
  const image = img.src;
  fill_captcha(image);
};

const pre_img = (img) => {
  let avg = 0;
  img.forEach((e) => e.forEach((f) => (avg += f)));
  avg /= 24 * 22;
  var bits = new Array(img.length);
  for (let i = 0; i < img.length; i += 1) {
    bits[i] = new Array(img[0].length);
    for (let j = 0; j < img[0].length; j += 1) {
      if (img[i][j] > avg) {
        bits[i][j] = 1;
      } else {
        bits[i][j] = 0;
      }
    }
  }
  return bits;
};

const saturation = (d) => {
  let saturate = new Array(d.length / 4);
  for (let i = 0; i < d.length; i += 4) {
    let min = Math.min(d[i], d[i + 1], d[i + 2]);
    let max = Math.max(d[i], d[i + 1], d[i + 2]);
    saturate[i / 4] = Math.round(((max - min) * 255) / max);
  }
  var img = new Array(40);
  for (let i = 0; i < 40; i += 1) {
    img[i] = new Array(200);
    for (let j = 0; j < 200; j += 1) {
      img[i][j] = saturate[i * 200 + j];
    }
  }
  let bls = new Array(6);
  for (let i = 0; i < 6; i += 1) {
    let x1 = (i + 1) * 25 + 2;
    let y1 = 7 + 5 * (i % 2) + 1;
    let x2 = (i + 2) * 25 + 1;
    let y2 = 35 - 5 * ((i + 1) % 2);
    bls[i] = img.slice(y1, y2).map((i) => i.slice(x1, x2));
  }
  return bls;
};

const flatten = (arr) => {
  var bits = new Array(arr.length * arr[0].length);
  for (let i = 0; i < arr.length; i += 1) {
    for (let j = 0; j < arr[0].length; j += 1) {
      bits[i * arr[0].length + j] = arr[i][j];
    }
  }
  return bits;
};

const mat_mul = (a, b) => {
  let x = a.length,
    z = a[0].length,
    y = b[0].length;
  let productRow = Array.apply(null, new Array(y)).map(
    Number.prototype.valueOf,
    0
  );
  let product = new Array(x);
  for (let p = 0; p < x; p++) {
    product[p] = productRow.slice();
  }
  for (let i = 0; i < x; i++) {
    for (let j = 0; j < y; j++) {
      for (let k = 0; k < z; k++) {
        product[i][j] += a[i][k] * b[k][j];
      }
    }
  }
  return product;
};

const mat_add = (a, b) => {
  let x = a.length;
  let c = new Array(x);
  for (let i = 0; i < x; i++) {
    c[i] = a[i] + b[i];
  }
  return c;
};

const max_soft = (a) => {
  var n = [...a];
  let s = 0;
  n.forEach((f) => {
    s += Math.exp(f);
  });
  for (let i = 0; i < a.length; i++) {
    n[i] = Math.exp(a[i]) / s;
  }
  return n;
};

// weights.json is ~600 KB of the extension's 790 KB. It was re-fetched and
// re-parsed on every solve, which is once per captcha refresh — and with the
// refresh loop in refreshTillCaptcha.js that is now several times per login.
// Fetch it once per page instead.
let weightsPromise = null;
const loadWeights = () => {
  if (!weightsPromise) {
    weightsPromise = fetch(chrome.runtime.getURL("js/captcha/weights.json"))
      .then((response) => response.json())
      .catch((error) => {
        weightsPromise = null; // a failed load must not poison every later try
        throw error;
      });
  }
  return weightsPromise;
};

const solve = (img, textB) => {
  loadWeights()
    .then((data) => {
      const weights = data.weights;
      const biases = data.biases;
      const label_txt = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const pd = ctx.getImageData(0, 0, 200, 40);
      let bls = saturation(pd.data);
      let out = "";
      for (let i = 0; i < 6; i += 1) {
        bls[i] = pre_img(bls[i]);
        bls[i] = [flatten(bls[i])];
        bls[i] = mat_mul(bls[i], weights);
        bls[i] = mat_add(...bls[i], biases);
        bls[i] = max_soft(bls[i]);
        bls[i] = bls[i].indexOf(Math.max(...bls[i]));
        out += label_txt[bls[i]];
      }
      textB.value = out;
    })
    .catch(() => {
      // model unavailable — leave the field alone so the student can type it
    });
};

function myMain(evt) {
  if (document.URL.match("https://vtopcc.vit.ac.in/vtop/initialProcess")) {
    const jsInitChecktimer = setInterval(checkForJS_Finish, 111);
    function checkForJS_Finish() {
      let element = document.querySelector('img[alt="vtopCaptcha"]');
      if (element) {
        clearInterval(jsInitChecktimer);
        solve_captcha(element);
        let observer = new MutationObserver(function () {
          solve_captcha(document.querySelector('img[alt="vtopCaptcha"]'));
        });
        observer.observe(document.getElementById("captchaRefresh"), {
          childList: true,
        });
      }
    }
  } else if (
    document.URL.match("https://vtop.vitap.ac.in/vtop/initialProcess")
  ) {
    const jsInitChecktimer = setInterval(checkForJS_Finish, 111);
    function checkForJS_Finish() {
      let element = document.querySelector('img[alt="vtopCaptcha"]');
      if (element) {
        clearInterval(jsInitChecktimer);
        solve_captcha(element);
        let observer = new MutationObserver(function () {
          solve_captcha(document.querySelector('img[alt="vtopCaptcha"]'));
        });
        observer.observe(document.getElementById("captchaRefresh"), {
          childList: true,
        });
      }
    }
  } else if (document.URL.match("https://vtop.vitap.ac.in/vtop/login")) {
    /*
     * This branch used to run exactly once, on window "load", and then never
     * again. Every route that replaces the captcha afterwards therefore left
     * the box blank and the field empty:
     *   - VTOP's own green ⟳ button (loadCaptcha() swaps #captchaBlock)
     *   - a failed submit, which re-renders the page with a new captcha
     *   - refreshTillCaptcha.js healing a login page that arrived without one
     * That is the majority of the times a student actually looks at the field,
     * so "the solver works" and "the field is filled for me" were two very
     * different claims. Re-solve whenever the image changes.
     */
    const solveNow = () => {
      const img = document.querySelector("#captchaBlock img") ||
        document.getElementsByClassName("form-control img-fluid bg-light border-0")[0];
      const textB = document.getElementById("captchaStr");
      if (!img || !textB) return false; // role-picker/404: no captcha here
      if (!/^data:image\//.test(img.getAttribute("src") || "")) return false;
      img.style.height = "40px!important";
      img.style.width = "200px!important";
      // A decoded <img> is required before getImageData sees anything but
      // transparent pixels. On a fresh innerHTML swap it usually is not.
      const run = () => solve(img, textB);
      if (img.complete && img.naturalWidth > 0) run();
      else img.addEventListener("load", run, { once: true });
      return true;
    };

    solveNow();
    const submitB = document.getElementById("submitBtn");
    if (submitB) submitB.focus();

    // Both signals, because neither alone is reliable: the CustomEvent covers
    // refreshTillCaptcha.js's in-place swap, and the observer covers VTOP's own
    // refresh button (and fires even if this script loaded after the swap).
    document.addEventListener("vrevamp:captcha-changed", solveNow);
    /*
     * Same fix as refreshTillCaptcha.js, for the same reason and found the same
     * morning: /vtop/login can serve the four-role landing page, and the login
     * form (with #captchaBlock) arrives only after Student is pressed, at the
     * same URL. Attaching once at load meant that on that path the observer was
     * never attached at all, so the box stayed blank however well the model
     * worked. Capped poll, never an observer on body — a wedged main thread on
     * the login page means nobody signs in.
     */
    const attachBlock = () => {
      const block = document.getElementById("captchaBlock");
      if (!block) return false;
      new MutationObserver(() => solveNow()).observe(block, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"],
      });
      solveNow();
      return true;
    };
    if (!attachBlock()) {
      let ticks = 0;
      const timer = setInterval(() => {
        ticks++;
        // reCAPTCHA variant: no image is ever coming, and solving it is not
        // something this project does. Stop looking.
        const recaptcha = !!document.querySelector(
          "input[name='gResponse'], input#gResponse, .g-recaptcha"
        );
        if (recaptcha || attachBlock() || ticks >= 20) clearInterval(timer);
      }, 400);
    }
  } else {
    let img = document.getElementById("captcha_id");
    let textB = document.getElementById("captchaString");
    let submitB = document.getElementById("loginButton");
    if (!img || !textB || !submitB) return; // no captcha on this page
    img.style.height = "40px!important";
    img.style.width = "200px!important";
    solve(img, textB);
    submitB.focus();
  }
}

window.addEventListener("load", myMain, false);
